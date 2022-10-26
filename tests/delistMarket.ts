import * as anchor from '@project-serum/anchor';
import { assert } from 'chai';

import { Program } from '@project-serum/anchor';

import { PublicKey } from '@solana/web3.js';

import {
	Wallet,
	BASE_PRECISION,
	BN,
	OracleSource,
	ZERO,
	Admin,
	ClearingHouse,
	convertToNumber,
	PRICE_PRECISION,
	PositionDirection,
	EventSubscriber,
	QUOTE_PRECISION,
	calculateBaseAssetValueWithOracle,
	OracleGuardRails,
} from '../sdk/src';

import {
	mockOracle,
	mockUSDCMint,
	mockUserUSDCAccount,
	setFeedPrice,
	initializeQuoteSpotMarket,
	createUserWithUSDCAndWSOLAccount,
	initializeSolSpotMarket,
	printTxLogs,
	getFeedData,
	getOraclePriceData,
	sleep,
} from './testHelpers';
import { isVariant } from '../sdk';
import { Keypair } from '@solana/web3.js';

async function depositToFeePoolFromIF(
	amount: number,
	clearingHouse: Admin,
	userUSDCAccount: Keypair
) {
	const ifAmount = new BN(amount * QUOTE_PRECISION.toNumber());
	// const state = await clearingHouse.getStateAccount();
	// const tokenIx = Token.createTransferInstruction(
	// 	TOKEN_PROGRAM_ID,
	// 	userUSDCAccount.publicKey,
	// 	state.insuranceVault,
	// 	clearingHouse.provider.wallet.publicKey,
	// 	// usdcMint.publicKey,
	// 	[],
	// 	ifAmount.toNumber()
	// );
	//
	// await sendAndConfirmTransaction(
	// 	clearingHouse.provider.connection,
	// 	new Transaction().add(tokenIx),
	// 	// @ts-ignore
	// 	[clearingHouse.provider.wallet.payer],
	// 	{
	// 		skipPreflight: false,
	// 		commitment: 'recent',
	// 		preflightCommitment: 'recent',
	// 	}
	// );

	console.log(userUSDCAccount.publicKey.toString());
	// // send $50 to market from IF
	const txSig00 = await clearingHouse.depositIntoPerpMarketFeePool(
		0,
		ifAmount,
		userUSDCAccount.publicKey
	);
	console.log(txSig00);
}

describe('delist market', () => {
	const provider = anchor.AnchorProvider.local(undefined, {
		preflightCommitment: 'confirmed',
		commitment: 'confirmed',
	});
	const connection = provider.connection;
	anchor.setProvider(provider);
	const chProgram = anchor.workspace.ClearingHouse as Program;

	let clearingHouse: Admin;
	const eventSubscriber = new EventSubscriber(connection, chProgram);
	eventSubscriber.subscribe();

	let usdcMint;
	let userUSDCAccount;
	let userUSDCAccount2;

	let clearingHouseLoser: ClearingHouse;

	let liquidatorClearingHouse: ClearingHouse;
	let liquidatorClearingHouseWSOLAccount: PublicKey;

	let solOracle: PublicKey;

	// ammInvariant == k == x * y
	const mantissaSqrtScale = new BN(Math.sqrt(PRICE_PRECISION.toNumber()));
	const ammInitialQuoteAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);
	const ammInitialBaseAssetReserve = new anchor.BN(5 * 10 ** 13).mul(
		mantissaSqrtScale
	);

	const usdcAmount = new BN(1000 * 10 ** 6);
	const userKeypair = new Keypair();

	before(async () => {
		usdcMint = await mockUSDCMint(provider);
		userUSDCAccount = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount.mul(new BN(10)),
			provider
		);

		solOracle = await mockOracle(43.1337);

		clearingHouse = new Admin({
			connection,
			wallet: provider.wallet,
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});

		await clearingHouse.initialize(usdcMint.publicKey, true);
		await clearingHouse.subscribe();

		await initializeQuoteSpotMarket(clearingHouse, usdcMint.publicKey);
		await initializeSolSpotMarket(clearingHouse, solOracle);
		await clearingHouse.updatePerpAuctionDuration(new BN(0));

		const periodicity = new BN(0);

		await clearingHouse.initializePerpMarket(
			solOracle,
			ammInitialBaseAssetReserve,
			ammInitialQuoteAssetReserve,
			periodicity,
			new BN(43_133_000)
		);

		// await clearingHouse.updatePerpMarketBaseSpread(new BN(0), 2000);
		// await clearingHouse.updatePerpMarketCurveUpdateIntensity(new BN(0), 100);
		await clearingHouse.updatePerpMarketStepSizeAndTickSize(
			0,
			new BN(1),
			new BN(1)
		);
		await clearingHouse.updatePerpMarketMinOrderSize(0, new BN(1));

		await clearingHouse.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount.publicKey
		);

		await provider.connection.requestAirdrop(userKeypair.publicKey, 10 ** 9);
		userUSDCAccount2 = await mockUserUSDCAccount(
			usdcMint,
			usdcAmount,
			provider,
			userKeypair.publicKey
		);
		clearingHouseLoser = new Admin({
			connection,
			wallet: new Wallet(userKeypair),
			programID: chProgram.programId,
			opts: {
				commitment: 'confirmed',
			},
			activeSubAccountId: 0,
			perpMarketIndexes: [0],
			spotMarketIndexes: [0, 1],
			oracleInfos: [
				{
					publicKey: solOracle,
					source: OracleSource.PYTH,
				},
			],
		});
		await clearingHouseLoser.subscribe();
		await clearingHouseLoser.initializeUserAccountAndDepositCollateral(
			usdcAmount,
			userUSDCAccount2.publicKey
		);
	});

	after(async () => {
		await clearingHouse.unsubscribe();
		await clearingHouseLoser.unsubscribe();
		await liquidatorClearingHouse.unsubscribe();
		await eventSubscriber.unsubscribe();
	});

	it('put market in big drawdown and net user positive pnl', async () => {
		await sleep(1000);
		await depositToFeePoolFromIF(1000, clearingHouse, userUSDCAccount);
		await clearingHouse.fetchAccounts();
		// try {
		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION,
			0,
			new BN(0)
		);
		// } catch (e) {
		// 	console.log('clearingHouse.openPosition');

		// 	console.error(e);
		// }

		// todo
		// try {
		await clearingHouseLoser.fetchAccounts();

		await clearingHouseLoser.openPosition(
			PositionDirection.LONG,
			new BN(2000 * 2),
			0
		);
		// } catch (e) {
		// 	console.log('clearingHouseLoserc.openPosition');

		// 	console.error(e);
		// 	return 0;
		// }

		await clearingHouse.fetchAccounts();
		const market00 = clearingHouse.getPerpMarketAccount(0);
		assert(market00.amm.feePool.scaledBalance.eq(new BN(1000000000000)));

		const solAmount = new BN(1 * 10 ** 9);
		[liquidatorClearingHouse, liquidatorClearingHouseWSOLAccount] =
			await createUserWithUSDCAndWSOLAccount(
				provider,
				usdcMint,
				chProgram,
				solAmount,
				usdcAmount,
				[0],
				[0, 1],
				[
					{
						publicKey: solOracle,
						source: OracleSource.PYTH,
					},
				]
			);
		await liquidatorClearingHouse.subscribe();

		const bankIndex = 1;
		await liquidatorClearingHouse.deposit(
			solAmount,
			bankIndex,
			liquidatorClearingHouseWSOLAccount
		);

		const market0 = clearingHouse.getPerpMarketAccount(0);
		const winnerUser = clearingHouse.getUserAccount();
		const loserUser = clearingHouseLoser.getUserAccount();
		console.log(winnerUser.perpPositions[0].quoteAssetAmount.toString());
		console.log(loserUser.perpPositions[0].quoteAssetAmount.toString());

		assert(
			market0.amm.quoteAssetAmount.eq(
				winnerUser.perpPositions[0].quoteAssetAmount.add(
					loserUser.perpPositions[0].quoteAssetAmount
				)
			)
		);
	});

	it('go through multiple market state changes', async () => {
		const marketIndex = 0;
		const oracleGuardRails: OracleGuardRails = {
			priceDivergence: {
				markOracleDivergenceNumerator: new BN(10),
				markOracleDivergenceDenominator: new BN(1),
			},
			validity: {
				slotsBeforeStaleForAmm: new BN(100),
				slotsBeforeStaleForMargin: new BN(100),
				confidenceIntervalMaxSize: new BN(100000),
				tooVolatileRatio: new BN(100000000),
			},
			useForLiquidations: false,
		};

		await clearingHouse.updateOracleGuardRails(oracleGuardRails);

		await clearingHouse.updateFundingRate(marketIndex, solOracle);

		await clearingHouse.fetchAccounts();
		const perpMarket = await clearingHouse.getPerpMarketAccount(marketIndex);
		console.log(perpMarket.amm.cumulativeFundingRateLong.toString());
		assert(!perpMarket.amm.cumulativeFundingRateLong.eq(ZERO));

		await liquidatorClearingHouse.addPerpLpShares(BASE_PRECISION, marketIndex);
		await clearingHouse.updateK(
			marketIndex,
			perpMarket.amm.sqrtK.mul(new BN(10012345)).div(new BN(9912345))
		);
		await clearingHouse.openPosition(
			PositionDirection.LONG,
			BASE_PRECISION,
			0,
			new BN(0)
		);
		await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);
		await clearingHouse.updateK(marketIndex, perpMarket.amm.sqrtK);
		await clearingHouse.openPosition(
			PositionDirection.SHORT,
			BASE_PRECISION,
			0,
			new BN(0)
		);
		await clearingHouse.updateFundingRate(marketIndex, solOracle);
		await liquidatorClearingHouse.removePerpLpShares(marketIndex);
		await clearingHouse.updateK(
			marketIndex,
			perpMarket.amm.sqrtK.mul(new BN(9912345)).div(new BN(10012345))
		);
		await liquidatorClearingHouse.closePosition(marketIndex);

		// sol tanks 90%
		await clearingHouse.moveAmmToPrice(
			0,
			new BN(43.1337 * PRICE_PRECISION.toNumber()).div(new BN(10))
		);
		await setFeedPrice(anchor.workspace.Pyth, 43.1337 / 10, solOracle);
	});

	it('put market in reduce only mode', async () => {
		const marketIndex = 0;
		const slot = await connection.getSlot();
		const now = await connection.getBlockTime(slot);
		const expiryTs = new BN(now + 3);

		const market0 = clearingHouse.getPerpMarketAccount(marketIndex);
		assert(market0.expiryTs.eq(ZERO));

		await clearingHouse.updatePerpMarketExpiry(marketIndex, expiryTs);
		await sleep(1000);
		clearingHouse.fetchAccounts();

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log(market.status);
		assert(isVariant(market.status, 'reduceOnly'));
		console.log(
			'market.expiryTs == ',
			market.expiryTs.toString(),
			'(',
			expiryTs.toString(),
			')'
		);
		assert(market.expiryTs.eq(expiryTs));

		console.log('totalExchangeFee:', market.amm.totalExchangeFee.toString());
		console.log('totalFee:', market.amm.totalFee.toString());
		console.log('totalMMFee:', market.amm.totalMmFee.toString());
		console.log(
			'totalFeeMinusDistributions:',
			market.amm.totalFeeMinusDistributions.toString()
		);

		await clearingHouse.fetchAccounts();
		console.log(
			'lastOraclePriceTwap:',
			market.amm.historicalOracleData.lastOraclePriceTwap.toString()
		);
		assert(
			market.amm.historicalOracleData.lastOraclePriceTwap.eq(new BN(43133700))
		);

		// should fail
		try {
			await clearingHouseLoser.openPosition(
				PositionDirection.LONG,
				new BN(10000000),
				0,
				new BN(0)
			);
			console.log('risk increase trade succeed when it should have failed!');

			assert(false);
		} catch (e) {
			console.log(e);

			if (!e.toString().search('AnchorError occurred')) {
				assert(false);
			}
			console.log('risk increase trade failed');
		}

		await clearingHouseLoser.fetchAccounts();

		const loserUser0 = clearingHouseLoser.getUserAccount();
		console.log(loserUser0.perpPositions[0]);

		await clearingHouse.fetchAccounts();
		const marketBeforeReduceUser = clearingHouse.getPerpMarketAccount(0);
		console.log(
			'lastOraclePriceTwap:',
			marketBeforeReduceUser.amm.historicalOracleData.lastOraclePriceTwap.toString()
		);
		assert(
			marketBeforeReduceUser.amm.historicalOracleData.lastOraclePriceTwap.eq(
				new BN(43133700)
			)
		);
		// should succeed
		await clearingHouseLoser.openPosition(
			PositionDirection.SHORT,
			new BN(2000),
			0,
			new BN(0)
		);

		await clearingHouse.fetchAccounts();
		const marketBeforeReduceUser2 = clearingHouse.getPerpMarketAccount(0);
		console.log(
			'lastOraclePriceTwap:',
			marketBeforeReduceUser2.amm.historicalOracleData.lastOraclePriceTwap.toString()
		);
		// assert(marketBeforeReduceUser2.amm.historicalOracleData.lastOraclePriceTwap.eq(new BN(28755800)))
		assert(
			marketBeforeReduceUser2.amm.historicalOracleData.lastOraclePriceTwap.eq(
				new BN(19170534)
			)
		);
	});

	it('put market in settlement mode', async () => {
		const marketIndex = 0;
		let slot = await connection.getSlot();
		let now = await connection.getBlockTime(slot);

		const market0 = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log('market0.status:', market0.status);
		while (market0.expiryTs.gte(new BN(now))) {
			console.log(market0.expiryTs.toString(), '>', now);
			await sleep(1000);
			slot = await connection.getSlot();
			now = await connection.getBlockTime(slot);
		}

		const winningUserBefore = clearingHouse.getUserAccount();
		console.log(winningUserBefore.perpPositions[0]);
		const oraclePriceDataBefore = await getOraclePriceData(
			anchor.workspace.Pyth,
			solOracle
		);
		const beforeExpiryValue = calculateBaseAssetValueWithOracle(
			market0,
			winningUserBefore.perpPositions[0],
			oraclePriceDataBefore
		);

		// try {
		const txSig = await clearingHouse.settleExpiredMarket(marketIndex);
		// } catch (e) {
		// 	console.error(e);
		// }
		await printTxLogs(connection, txSig);

		clearingHouse.fetchAccounts();

		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		console.log(market.status);
		assert(isVariant(market.status, 'settlement'));
		console.log('market.expirytPrice:', convertToNumber(market.expiryPrice));
		console.log(
			'market.amm.historicalOracleData.lastOraclePriceTwap:',
			convertToNumber(market.amm.historicalOracleData.lastOraclePriceTwap)
		);
		assert(
			market.amm.historicalOracleData.lastOraclePriceTwap.eq(new BN(12780356))
		);

		const curPrice = (await getFeedData(anchor.workspace.Pyth, solOracle))
			.price;
		console.log('new oracle price:', curPrice);
		const oraclePriceData = await getOraclePriceData(
			anchor.workspace.Pyth,
			solOracle
		);
		assert(Math.abs(convertToNumber(oraclePriceData.price) - curPrice) < 1e-4);

		assert(market.expiryPrice.gt(ZERO));

		assert(market.amm.baseAssetAmountWithAmm.lt(ZERO));
		assert(oraclePriceData.price.lt(market.expiryPrice));
		assert(
			market.amm.historicalOracleData.lastOraclePriceTwap.lt(market.expiryPrice)
		);
		assert(
			market.expiryPrice.eq(
				market.amm.historicalOracleData.lastOraclePriceTwap.add(new BN(1))
			)
		);

		const winningUser = clearingHouse.getUserAccount();
		console.log(winningUser.perpPositions[0]);
		const afterExpiryValue = calculateBaseAssetValueWithOracle(
			market,
			winningUser.perpPositions[0],
			oraclePriceData
		);

		console.log(
			'user position value:',
			beforeExpiryValue.toString(),
			'->',
			afterExpiryValue.toString()
		);
		assert(beforeExpiryValue.lt(afterExpiryValue));
	});

	it('settle expired market position', async () => {
		const marketIndex = 0;
		await clearingHouseLoser.fetchAccounts();

		const loserUser0 = clearingHouseLoser.getUserAccount();
		console.log(loserUser0.perpPositions[0]);

		assert(loserUser0.perpPositions[0].baseAssetAmount.gt(new BN(0)));
		assert(loserUser0.perpPositions[0].quoteAssetAmount.lt(new BN(0)));

		const txSig = await clearingHouseLoser.settlePNL(
			await clearingHouseLoser.getUserAccountPublicKey(),
			clearingHouseLoser.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig);

		// const settleRecord = eventSubscriber.getEventsArray('SettlePnlRecord')[0];
		// console.log(settleRecord);

		await clearingHouseLoser.fetchAccounts();
		const loserUser = clearingHouseLoser.getUserAccount();
		// console.log(loserUser.perpPositions[0]);
		assert(loserUser.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		assert(loserUser.perpPositions[0].quoteAssetAmount.eq(new BN(0)));
		const marketAfter0 = clearingHouse.getPerpMarketAccount(marketIndex);

		const finalPnlResultMin0 = new BN(1000021789000 - 100090);
		console.log(marketAfter0.pnlPool.scaledBalance.toString());
		assert(marketAfter0.pnlPool.scaledBalance.gt(finalPnlResultMin0));
		assert(
			marketAfter0.pnlPool.scaledBalance.lt(new BN(1000021789000 + 1000000))
		);

		const txSig2 = await clearingHouse.settlePNL(
			await clearingHouse.getUserAccountPublicKey(),
			clearingHouse.getUserAccount(),
			marketIndex
		);
		await printTxLogs(connection, txSig2);
		await clearingHouse.fetchAccounts();
		const winnerUser = clearingHouse.getUserAccount();
		// console.log(winnerUser.perpPositions[0]);
		assert(winnerUser.perpPositions[0].baseAssetAmount.eq(new BN(0)));
		// assert(winnerUser.perpPositions[0].quoteAssetAmount.gt(new BN(0))); // todo they lose money too after fees

		// await clearingHouse.settlePNL(
		// 	await clearingHouseLoser.getUserAccountPublicKey(),
		// 	clearingHouseLoser.getUserAccount(),
		// 	marketIndex
		// );

		const marketAfter = clearingHouse.getPerpMarketAccount(marketIndex);

		const finalPnlResultMin = new BN(969700933000 - 109000);
		console.log('pnlPool:', marketAfter.pnlPool.scaledBalance.toString());
		assert(marketAfter.pnlPool.scaledBalance.gt(finalPnlResultMin));
		assert(marketAfter.pnlPool.scaledBalance.lt(new BN(969700933000 + 109000)));

		console.log('feePool:', marketAfter.amm.feePool.scaledBalance.toString());
		console.log(
			'totalExchangeFee:',
			marketAfter.amm.totalExchangeFee.toString()
		);
		assert(marketAfter.amm.feePool.scaledBalance.eq(new BN(21567000)));
		// assert(marketAfter.amm.totalExchangeFee.eq(new BN(43134)));
		assert(marketAfter.amm.totalExchangeFee.eq(new BN(129401)));
	});

	it('put settle market pools to revenue pool', async () => {
		const marketIndex = 0;
		const market = clearingHouse.getPerpMarketAccount(marketIndex);
		const userCostBasis = market.amm.quoteAssetAmount;

		console.log('userCostBasis:', userCostBasis.toString());
		assert(userCostBasis.eq(ZERO));
		try {
			await clearingHouse.settleExpiredMarketPoolsToRevenuePool(marketIndex);
		} catch (e) {
			console.log('failed');
		}

		await clearingHouse.updateStateSettlementDuration(1000); // too far away
		try {
			await clearingHouse.settleExpiredMarketPoolsToRevenuePool(marketIndex);
		} catch (e) {
			console.log('failed');
		}

		await clearingHouse.updateStateSettlementDuration(1);
		await clearingHouse.settleExpiredMarketPoolsToRevenuePool(marketIndex);

		await clearingHouse.fetchAccounts();
		const marketAfter = clearingHouse.getPerpMarketAccount(marketIndex);

		console.log(
			marketAfter.amm.baseAssetReserve.toString(),
			marketAfter.amm.quoteAssetReserve.toString(),
			marketAfter.amm.sqrtK.toString(),
			marketAfter.amm.terminalQuoteAssetReserve.toString()
		);

		console.log(marketAfter.pnlPool.scaledBalance.toString());
		console.log(marketAfter.amm.feePool.scaledBalance.toString());
		assert(
			marketAfter.amm.feePool.scaledBalance
				.add(marketAfter.pnlPool.scaledBalance)
				.eq(ZERO)
		);

		const usdcMarket = clearingHouse.getQuoteSpotMarketAccount();
		console.log(usdcMarket.revenuePool.scaledBalance.toString());
		assert(usdcMarket.revenuePool.scaledBalance.gt(ZERO));
		assert(
			usdcMarket.revenuePool.scaledBalance.gt(new BN(969765629000 - 100000))
		);
		assert(
			usdcMarket.revenuePool.scaledBalance.lt(new BN(969765629000 + 100000))
		);

		console.log('works');
	});
});
