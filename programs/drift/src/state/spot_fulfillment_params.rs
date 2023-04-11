use crate::controller::serum::{invoke_new_order, invoke_settle_funds};
use crate::error::{DriftResult, ErrorCode};
use crate::math::safe_math::SafeMath;
use crate::math::safe_unwrap::SafeUnwrap;
use crate::math::serum::{
    calculate_serum_limit_price, calculate_serum_max_coin_qty,
    calculate_serum_max_native_pc_quantity,
};
use crate::math::spot_withdraw::validate_spot_market_vault_amount;
use crate::state::events::OrderActionExplanation;
use crate::state::serum::{get_best_bid_and_ask, load_open_orders, load_serum_market};
use crate::state::spot_market::{SpotBalanceType, SpotMarket};
use crate::PositionDirection;
use anchor_lang::prelude::{Account, Program};
use anchor_lang::ToAccountInfo;
use anchor_spl::token::{Token, TokenAccount};
use serum_dex::instruction::{NewOrderInstructionV3, SelfTradeBehavior};
use serum_dex::matching::Side;
use solana_program::account_info::AccountInfo;
use solana_program::msg;
use std::cell::Ref;
use std::num::NonZeroU64;

pub trait SpotFulfillmentParams<'a, 'b> {
    fn is_external(&self) -> bool;

    fn get_best_bid_ask(
        &self,
        base_market_decimals: u32,
    ) -> DriftResult<(Option<u64>, Option<u64>)>;

    fn fulfill_order(
        &mut self,
        taker_direction: PositionDirection,
        taker_price: u64,
        taker_base_asset_amount: u64,
        taker_max_quote_asset_amount: u64,
        base_market_decimals: u32,
        now: i64,
    ) -> DriftResult<ExternalSpotFill>;

    fn get_order_action_explanation(&self) -> DriftResult<OrderActionExplanation>;

    fn validate_vault_amounts(
        &self,
        base_market: &Ref<SpotMarket>,
        quote_market: &Ref<SpotMarket>,
    ) -> DriftResult<()>;
}

pub struct MatchFulfillmentParams<'a> {
    pub base_market_vault: Box<Account<'a, TokenAccount>>,
    pub quote_market_vault: Box<Account<'a, TokenAccount>>,
}

impl<'a, 'b> SpotFulfillmentParams<'a, 'b> for MatchFulfillmentParams<'b> {
    fn is_external(&self) -> bool {
        false
    }

    fn get_best_bid_ask(
        &self,
        _base_market_decimals: u32,
    ) -> DriftResult<(Option<u64>, Option<u64>)> {
        Err(ErrorCode::InvalidSpotFulfillmentParams)
    }

    fn fulfill_order(
        &mut self,
        _taker_direction: PositionDirection,
        _taker_price: u64,
        _taker_base_asset_amount: u64,
        _taker_max_quote_asset_amount: u64,
        _base_market_decimals: u32,
        _now: i64,
    ) -> DriftResult<ExternalSpotFill> {
        Err(ErrorCode::InvalidSpotFulfillmentParams)
    }

    fn get_order_action_explanation(&self) -> DriftResult<OrderActionExplanation> {
        Err(ErrorCode::InvalidSpotFulfillmentParams)
    }

    fn validate_vault_amounts(
        &self,
        base_market: &Ref<SpotMarket>,
        quote_market: &Ref<SpotMarket>,
    ) -> DriftResult<()> {
        validate_spot_market_vault_amount(base_market, self.base_market_vault.amount)?;

        validate_spot_market_vault_amount(quote_market, self.quote_market_vault.amount)?;

        Ok(())
    }
}

pub struct ExternalSpotFill {
    pub base_asset_amount_filled: u64,
    pub base_update_direction: SpotBalanceType,
    pub quote_asset_amount_filled: u64,
    pub quote_update_direction: SpotBalanceType,
    pub settled_referrer_rebate: u64,
    pub unsettled_referrer_rebate: u64,
    pub fee: u64,
}

impl ExternalSpotFill {
    pub fn empty() -> ExternalSpotFill {
        ExternalSpotFill {
            base_asset_amount_filled: 0,
            base_update_direction: SpotBalanceType::Deposit,
            quote_asset_amount_filled: 0,
            quote_update_direction: SpotBalanceType::Borrow,
            settled_referrer_rebate: 0,
            unsettled_referrer_rebate: 0,
            fee: 0,
        }
    }
}

pub struct SerumFulfillmentParams<'a, 'b> {
    pub drift_signer: &'a AccountInfo<'b>,
    pub serum_program_id: &'a AccountInfo<'b>,
    pub serum_market: &'a AccountInfo<'b>,
    pub serum_request_queue: &'a AccountInfo<'b>,
    pub serum_event_queue: &'a AccountInfo<'b>,
    pub serum_bids: &'a AccountInfo<'b>,
    pub serum_asks: &'a AccountInfo<'b>,
    pub serum_base_vault: &'a AccountInfo<'b>,
    pub serum_quote_vault: &'a AccountInfo<'b>,
    pub serum_open_orders: &'a AccountInfo<'b>,
    pub token_program: Program<'b, Token>,
    pub base_market_vault: Box<Account<'b, TokenAccount>>,
    pub quote_market_vault: Box<Account<'b, TokenAccount>>,
    pub srm_vault: &'a AccountInfo<'b>,
    pub serum_signer: &'a AccountInfo<'b>,
    pub signer_nonce: u8,
}

impl<'a, 'b> SpotFulfillmentParams<'a, 'b> for SerumFulfillmentParams<'a, 'b> {
    fn is_external(&self) -> bool {
        true
    }

    fn get_best_bid_ask(
        &self,
        base_market_decimals: u32,
    ) -> DriftResult<(Option<u64>, Option<u64>)> {
        get_best_bid_and_ask(
            self.serum_market,
            self.serum_bids,
            self.serum_asks,
            self.serum_program_id.key,
            base_market_decimals,
        )
    }

    fn fulfill_order(
        &mut self,
        taker_direction: PositionDirection,
        taker_price: u64,
        taker_base_asset_amount: u64,
        taker_max_quote_asset_amount: u64,
        base_market_decimals: u32,
        now: i64,
    ) -> DriftResult<ExternalSpotFill> {
        let market_state_before = load_serum_market(self.serum_market, self.serum_program_id.key)?;

        let serum_order_side = match taker_direction {
            PositionDirection::Long => Side::Bid,
            PositionDirection::Short => Side::Ask,
        };

        let serum_max_coin_qty = calculate_serum_max_coin_qty(
            taker_base_asset_amount,
            market_state_before.coin_lot_size,
        )?;

        let serum_limit_price = calculate_serum_limit_price(
            taker_price,
            market_state_before.pc_lot_size,
            base_market_decimals,
            market_state_before.coin_lot_size,
            taker_direction,
        )?;

        let serum_max_native_pc_qty = calculate_serum_max_native_pc_quantity(
            serum_limit_price,
            serum_max_coin_qty,
            market_state_before.pc_lot_size,
        )?
        .min(taker_max_quote_asset_amount);

        if serum_max_coin_qty == 0 || serum_max_native_pc_qty == 0 {
            return Ok(ExternalSpotFill::empty());
        }

        let serum_order = NewOrderInstructionV3 {
            side: serum_order_side,
            limit_price: NonZeroU64::new(serum_limit_price).safe_unwrap()?,
            max_coin_qty: NonZeroU64::new(serum_max_coin_qty).safe_unwrap()?, // max base to deposit into serum
            max_native_pc_qty_including_fees: NonZeroU64::new(serum_max_native_pc_qty)
                .safe_unwrap()?, // max quote to deposit into serum
            self_trade_behavior: SelfTradeBehavior::AbortTransaction,
            order_type: serum_dex::matching::OrderType::ImmediateOrCancel,
            client_order_id: 0,
            limit: 10,
            max_ts: now,
        };

        let _market_fees_accrued_before = market_state_before.pc_fees_accrued;
        let base_before = self.base_market_vault.amount;
        let quote_before = self.quote_market_vault.amount;
        let market_rebates_accrued_before = market_state_before.referrer_rebates_accrued;

        drop(market_state_before);

        invoke_new_order(
            self.serum_program_id,
            self.serum_market,
            self.serum_open_orders,
            self.serum_request_queue,
            self.serum_event_queue,
            self.serum_bids,
            self.serum_asks,
            &match taker_direction {
                PositionDirection::Long => self.quote_market_vault.to_account_info(),
                PositionDirection::Short => self.base_market_vault.to_account_info(),
            },
            self.drift_signer,
            self.serum_base_vault,
            self.serum_quote_vault,
            self.srm_vault,
            &self.token_program.to_account_info(),
            serum_order,
            self.signer_nonce,
        )?;

        let market_state_after = load_serum_market(self.serum_market, self.serum_program_id.key)?;

        let _market_fees_accrued_after = market_state_after.pc_fees_accrued;
        let market_rebates_accrued_after = market_state_after.referrer_rebates_accrued;

        drop(market_state_after);

        let open_orders_before = load_open_orders(self.serum_open_orders)?;
        let unsettled_referrer_rebate_before = open_orders_before.referrer_rebates_accrued;

        drop(open_orders_before);

        invoke_settle_funds(
            self.serum_program_id,
            self.serum_market,
            self.serum_open_orders,
            self.drift_signer,
            self.serum_base_vault,
            self.serum_quote_vault,
            &self.base_market_vault.to_account_info(),
            &self.quote_market_vault.to_account_info(),
            self.serum_signer,
            &self.token_program.to_account_info(),
            self.signer_nonce,
        )?;

        self.base_market_vault.reload().map_err(|_e| {
            msg!("Failed to reload base_market_vault");
            ErrorCode::FailedSerumCPI
        })?;
        self.quote_market_vault.reload().map_err(|_e| {
            msg!("Failed to reload quote_market_vault");
            ErrorCode::FailedSerumCPI
        })?;

        let base_after = self.base_market_vault.amount;
        let quote_after = self.quote_market_vault.amount;

        let open_orders_after = load_open_orders(self.serum_open_orders)?;
        let unsettled_referrer_rebate_after = open_orders_after.referrer_rebates_accrued;

        drop(open_orders_after);

        let settled_referred_rebate =
            unsettled_referrer_rebate_before.safe_sub(unsettled_referrer_rebate_after)?;

        let (base_update_direction, base_asset_amount_filled) = if base_after > base_before {
            (SpotBalanceType::Deposit, base_after.safe_sub(base_before)?)
        } else {
            (SpotBalanceType::Borrow, base_before.safe_sub(base_after)?)
        };

        if base_asset_amount_filled == 0 {
            msg!("No base filled on serum");
            return Ok(ExternalSpotFill::empty());
        }

        let serum_referrer_rebate =
            market_rebates_accrued_after.safe_sub(market_rebates_accrued_before)?;

        // rebate is half of taker fee
        let serum_fee = serum_referrer_rebate;

        let (quote_update_direction, quote_asset_amount_filled) =
            if base_update_direction == SpotBalanceType::Borrow {
                let quote_asset_amount_delta = quote_after
                    .safe_sub(quote_before)?
                    .safe_sub(settled_referred_rebate)?;

                (
                    SpotBalanceType::Deposit,
                    quote_asset_amount_delta
                        .safe_add(serum_fee)?
                        .safe_add(serum_referrer_rebate)?,
                )
            } else {
                let quote_asset_amount_delta = quote_before
                    .safe_add(settled_referred_rebate)?
                    .safe_sub(quote_after)?;

                (
                    SpotBalanceType::Borrow,
                    quote_asset_amount_delta
                        .safe_sub(serum_fee)?
                        .safe_sub(serum_referrer_rebate)?,
                )
            };

        Ok(ExternalSpotFill {
            base_asset_amount_filled,
            quote_asset_amount_filled,
            base_update_direction,
            quote_update_direction,
            fee: serum_fee,
            unsettled_referrer_rebate: serum_referrer_rebate,
            settled_referrer_rebate: settled_referred_rebate,
        })
    }

    fn get_order_action_explanation(&self) -> DriftResult<OrderActionExplanation> {
        Ok(OrderActionExplanation::OrderFillWithSerum)
    }

    fn validate_vault_amounts(
        &self,
        base_market: &Ref<SpotMarket>,
        quote_market: &Ref<SpotMarket>,
    ) -> DriftResult {
        validate_spot_market_vault_amount(base_market, self.base_market_vault.amount)?;

        validate_spot_market_vault_amount(quote_market, self.quote_market_vault.amount)?;

        Ok(())
    }
}

#[cfg(test)]
pub struct TestFulfillmentParams {}

#[cfg(test)]
impl<'a, 'b> SpotFulfillmentParams<'a, 'b> for TestFulfillmentParams {
    fn is_external(&self) -> bool {
        false
    }

    fn get_best_bid_ask(
        &self,
        _base_market_decimals: u32,
    ) -> DriftResult<(Option<u64>, Option<u64>)> {
        Err(ErrorCode::InvalidSpotFulfillmentParams)
    }

    fn fulfill_order(
        &mut self,
        _taker_direction: PositionDirection,
        _taker_price: u64,
        _taker_base_asset_amount: u64,
        _taker_max_quote_asset_amount: u64,
        _base_market_decimals: u32,
        _now: i64,
    ) -> DriftResult<ExternalSpotFill> {
        Err(ErrorCode::InvalidSpotFulfillmentParams)
    }

    fn get_order_action_explanation(&self) -> DriftResult<OrderActionExplanation> {
        Err(ErrorCode::InvalidSpotFulfillmentParams)
    }

    fn validate_vault_amounts(
        &self,
        _base_market: &Ref<SpotMarket>,
        _quote_market: &Ref<SpotMarket>,
    ) -> DriftResult<()> {
        Err(ErrorCode::InvalidSpotFulfillmentParams)
    }
}
