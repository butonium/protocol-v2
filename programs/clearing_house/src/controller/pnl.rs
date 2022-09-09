use crate::controller::amm::{update_pnl_pool_and_user_balance, update_pool_balances};
use crate::controller::bank_balance::{update_bank_balances, update_bank_cumulative_interest};
use crate::controller::funding::settle_funding_payment;
use crate::controller::position::{
    get_position_index, update_position_and_market, update_quote_asset_amount, update_realized_pnl,
    PositionDelta,
};
use crate::error::{ClearingHouseResult, ErrorCode};
use crate::math::casting::cast;
use crate::math::casting::cast_to_i128;
use crate::math::casting::cast_to_i64;
use crate::math::margin::meets_maintenance_margin_requirement;
use crate::math::position::calculate_base_asset_value_and_pnl_with_settlement_price;
use crate::math_error;
use crate::state::bank::BankBalanceType;
use crate::state::bank_map::BankMap;
use crate::state::events::SettlePnlRecord;
use crate::state::market::MarketStatus;
use crate::state::market_map::MarketMap;
use crate::state::oracle_map::OracleMap;
use crate::state::state::State;
use crate::state::user::User;
use crate::validate;
use anchor_lang::prelude::Pubkey;
use anchor_lang::prelude::*;
use solana_program::msg;
use std::ops::DerefMut;

#[cfg(test)]
mod tests;

#[cfg(test)]
mod delisting;

pub fn settle_pnl(
    market_index: u64,
    user: &mut User,
    authority: &Pubkey,
    user_key: &Pubkey,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
    now: i64,
) -> ClearingHouseResult {
    validate!(!user.bankrupt, ErrorCode::UserBankrupt)?;

    {
        let bank = &mut bank_map.get_quote_asset_bank_mut()?;
        update_bank_cumulative_interest(bank, now)?;
    }

    let mut market = market_map.get_ref_mut(&market_index)?;

    crate::controller::lp::settle_lp(user, user_key, &mut market, now)?;

    settle_funding_payment(user, user_key, &mut market, now)?;

    drop(market);

    // cannot settle pnl this way on a user who is in liquidation territory
    if !(meets_maintenance_margin_requirement(user, market_map, bank_map, oracle_map)?) {
        return Err(ErrorCode::InsufficientCollateralForSettlingPNL);
    }

    let position_index = get_position_index(&user.positions, market_index)?;

    let bank = &mut bank_map.get_quote_asset_bank_mut()?;
    let market = &mut market_map.get_ref_mut(&market_index)?;

    // todo, check amm updated
    validate!(
        ((oracle_map.slot == market.amm.last_update_slot && market.amm.last_oracle_valid)
            || market.amm.curve_update_intensity == 0),
        ErrorCode::AMMNotUpdatedInSameSlot,
        "AMM must be updated in a prior instruction within same slot"
    )?;

    validate!(
        market.status == MarketStatus::Initialized,
        ErrorCode::DefaultError,
        "Cannot settle pnl under current market status"
    )?;

    let oracle_price = oracle_map.get_price_data(&market.amm.oracle)?.price;
    let user_unsettled_pnl: i128 =
        user.positions[position_index].get_unsettled_pnl(oracle_price)?;

    let pnl_to_settle_with_user = update_pool_balances(market, bank, user_unsettled_pnl, now)?;
    if user_unsettled_pnl == 0 {
        msg!("User has no unsettled pnl for market {}", market_index);
        return Ok(());
    } else if pnl_to_settle_with_user == 0 {
        msg!(
            "Pnl Pool cannot currently settle with user for market {}",
            market_index
        );
        return Ok(());
    }

    validate!(
        pnl_to_settle_with_user < 0 || user.authority.eq(authority),
        ErrorCode::UserMustSettleTheirOwnPositiveUnsettledPNL,
        "User must settle their own unsettled pnl when its positive",
    )?;

    update_bank_balances(
        pnl_to_settle_with_user.unsigned_abs(),
        if pnl_to_settle_with_user > 0 {
            &BankBalanceType::Deposit
        } else {
            &BankBalanceType::Borrow
        },
        bank,
        user.get_quote_asset_bank_balance_mut(),
        false,
    )?;

    update_quote_asset_amount(
        &mut user.positions[position_index],
        market,
        -pnl_to_settle_with_user,
    )?;

    update_realized_pnl(
        &mut user.positions[position_index],
        cast(pnl_to_settle_with_user)?,
    )?;

    let base_asset_amount = user.positions[position_index].base_asset_amount;
    let quote_asset_amount_after = user.positions[position_index].quote_asset_amount;
    let quote_entry_amount = user.positions[position_index].quote_entry_amount;

    emit!(SettlePnlRecord {
        ts: now,
        user: *user_key,
        market_index,
        pnl: pnl_to_settle_with_user,
        base_asset_amount,
        quote_asset_amount_after,
        quote_entry_amount,
        settle_price: oracle_price,
    });

    Ok(())
}

pub fn settle_expired_position(
    market_index: u64,
    user: &mut User,
    user_key: &Pubkey,
    market_map: &MarketMap,
    bank_map: &BankMap,
    oracle_map: &mut OracleMap,
    now: i64,
    state: &State,
) -> ClearingHouseResult {
    // cannot settle pnl this way on a user who is in liquidation territory
    if !(meets_maintenance_margin_requirement(user, market_map, bank_map, oracle_map)?) {
        return Err(ErrorCode::InsufficientCollateralForSettlingPNL);
    }

    let fee_structure = &state.fee_structure;

    {
        let bank = &mut bank_map.get_quote_asset_bank_mut()?;
        update_bank_cumulative_interest(bank, now)?;
    }

    settle_funding_payment(
        user,
        user_key,
        market_map.get_ref_mut(&market_index)?.deref_mut(),
        now,
    )?;

    let position_index = get_position_index(&user.positions, market_index)?;

    let bank = &mut bank_map.get_quote_asset_bank_mut()?;
    let market = &mut market_map.get_ref_mut(&market_index)?;
    validate!(
        market.status == MarketStatus::Settlement,
        ErrorCode::DefaultError,
        "Market isn't in settlement, expiry_ts={}",
        market.expiry_ts
    )?;

    let position_settlement_ts = market
        .expiry_ts
        .checked_add(cast_to_i64(state.settlement_duration)?)
        .ok_or_else(math_error!())?;

    validate!(
        now > position_settlement_ts,
        ErrorCode::DefaultError,
        "Market requires {} seconds buffer to settle after expiry_ts",
        state.settlement_duration
    )?;

    validate!(
        user.positions[position_index].open_orders == 0,
        ErrorCode::DefaultError,
        "User must first cancel open orders for expired market"
    )?;

    let _oracle_price = oracle_map.get_price_data(&market.amm.oracle)?.price;
    let (base_asset_value, unrealized_pnl) =
        calculate_base_asset_value_and_pnl_with_settlement_price(
            &user.positions[position_index],
            market.settlement_price,
        )?;

    let fee = base_asset_value
        .checked_mul(fee_structure.fee_numerator)
        .ok_or_else(math_error!())?
        .checked_div(fee_structure.fee_denominator)
        .ok_or_else(math_error!())?;

    let unrealized_pnl_with_fee = unrealized_pnl
        .checked_sub(cast_to_i128(fee)?)
        .ok_or_else(math_error!())?;

    let pnl_to_settle_with_user =
        update_pnl_pool_and_user_balance(market, bank, user, unrealized_pnl_with_fee)?;

    let user_position = &mut user.positions[position_index];

    let base_asset_amount = user_position.base_asset_amount;
    let quote_entry_amount = user_position.quote_entry_amount;

    let position_delta = PositionDelta {
        quote_asset_amount: -user_position.quote_asset_amount,
        base_asset_amount: -user_position.base_asset_amount,
    };

    let _user_pnl = update_position_and_market(user_position, market, &position_delta)?;

    market.amm.net_base_asset_amount = market
        .amm
        .net_base_asset_amount
        .checked_add(position_delta.base_asset_amount)
        .ok_or_else(math_error!())?;

    let quote_asset_amount_after = user_position.quote_asset_amount;

    emit!(SettlePnlRecord {
        ts: now,
        user: *user_key,
        market_index,
        pnl: pnl_to_settle_with_user,
        base_asset_amount,
        quote_asset_amount_after,
        quote_entry_amount,
        settle_price: market.settlement_price,
    });

    validate!(
        user.positions[position_index].is_available(),
        ErrorCode::DefaultError,
        "Issue occurred in expired settlement"
    )?;

    Ok(())
}
