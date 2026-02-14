import { getYearMonthString, LocalDate } from "common";
import { InvestmentTransactionType } from "plaid";
import {
  HoldingSnapshot,
  HoldingSnapshotDictionary,
  SecuritySnapshotDictionary,
  InvestmentTransactionDictionary,
  HoldingsValueData,
  HoldingValueSummary,
  BalanceData,
  AccountDictionary,
} from "client";
import { Holding } from "../../models/miscellaneous";

/**
 * Build an index of security prices by security_id and yearMonth.
 * Takes the latest close_price for each security per month.
 */
export const buildSecurityPriceIndex = (
  securitySnapshots: SecuritySnapshotDictionary,
): Map<string, Map<string, number>> => {
  const index = new Map<string, Map<string, number>>();

  securitySnapshots.forEach(({ snapshot, security }) => {
    const { security_id, close_price } = security;
    if (!close_price) return;

    const yearMonth = getYearMonthString(new LocalDate(snapshot.date));

    if (!index.has(security_id)) {
      index.set(security_id, new Map());
    }
    // Keep latest price per month
    index.get(security_id)!.set(yearMonth, close_price);
  });

  return index;
};

/**
 * Get security price for a specific month from the index.
 * Falls back to the most recent prior month if exact match not found.
 */
export const getSecurityPriceForMonth = (
  priceIndex: Map<string, Map<string, number>>,
  securityId: string,
  targetYearMonth: string,
): number | undefined => {
  const prices = priceIndex.get(securityId);
  if (!prices) return undefined;

  // Exact match
  if (prices.has(targetYearMonth)) return prices.get(targetYearMonth);

  // Forward-fill: find most recent prior month
  const sortedMonths = Array.from(prices.keys()).sort();
  for (let i = sortedMonths.length - 1; i >= 0; i--) {
    if (sortedMonths[i] < targetYearMonth) {
      return prices.get(sortedMonths[i]);
    }
  }

  return undefined;
};

/**
 * Get the oldest security price month from the index.
 */
const getOldestSecurityPriceMonth = (
  priceIndex: Map<string, Map<string, number>>,
  securityId: string,
): string | undefined => {
  const prices = priceIndex.get(securityId);
  if (!prices || prices.size === 0) return undefined;
  return Array.from(prices.keys()).sort()[0];
};

/**
 * Get price for a holding with fallback logic:
 * 1. institution_price from holding (brokerage-reported)
 * 2. close_price from security snapshot (market data)
 * 3. Derive from institution_value / quantity
 */
export const getPriceForHolding = (
  holding: Holding,
  securityPriceIndex: Map<string, Map<string, number>>,
  yearMonth: string,
): number => {
  // Priority 1: Use institution_price from holding (brokerage-reported)
  if (holding.institution_price && holding.institution_price > 0) {
    return holding.institution_price;
  }

  // Priority 2: Use close_price from security snapshot (market data)
  const securityPrice = getSecurityPriceForMonth(
    securityPriceIndex,
    holding.security_id,
    yearMonth,
  );
  if (securityPrice) {
    return securityPrice;
  }

  // Priority 3: Infer from institution_value / quantity
  if (holding.institution_value && holding.quantity > 0) {
    return holding.institution_value / holding.quantity;
  }

  return 0;
};

/**
 * Check if cost basis is valid.
 * Cost basis is invalid if it's 0 but we have shares.
 */
export const isCostBasisValid = (holding: Holding): boolean => {
  return !(holding.cost_basis === 0 && holding.quantity !== 0);
};

/**
 * Infer cost basis from investment transactions using average cost method.
 * For a given security and target date, sum up all buy transactions
 * to calculate the average cost per share.
 */
export const inferCostBasis = (
  security_id: string,
  account_id: string,
  targetDate: Date,
  quantity: number,
  investmentTransactions: InvestmentTransactionDictionary,
  securityPriceIndex: Map<string, Map<string, number>>,
): number => {
  // Get all buy transactions for this security up to targetDate
  const buyTransactions = investmentTransactions
    .filter(
      (t) =>
        t.security_id === security_id &&
        t.account_id === account_id &&
        t.type === InvestmentTransactionType.Buy &&
        new Date(t.date) <= targetDate,
    )
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

  if (buyTransactions.length === 0) {
    // No buy transactions found - try to use security price at oldest available date
    const oldestYearMonth = getOldestSecurityPriceMonth(securityPriceIndex, security_id);
    if (oldestYearMonth) {
      const price = securityPriceIndex.get(security_id)!.get(oldestYearMonth)!;
      return quantity * price;
    }
    return 0;
  }

  // Calculate average cost basis from buy transactions
  let totalCost = 0;
  let totalShares = 0;

  for (const tx of buyTransactions) {
    totalCost += tx.price * tx.quantity;
    totalShares += tx.quantity;
  }

  if (totalShares === 0) return 0;

  const avgCostPerShare = totalCost / totalShares;
  return quantity * avgCostPerShare;
};

/**
 * Get balance data from holding snapshots.
 * Used as the middle tier in the 3-tier fallback:
 * Account Snapshot → Holding Snapshot → Transactions
 */
export const getBalanceDataFromHoldingSnapshots = (
  accounts: AccountDictionary,
  holdingSnapshots: HoldingSnapshotDictionary,
  securitySnapshots: SecuritySnapshotDictionary,
): BalanceData => {
  // Build security price index for fallback
  const securityPriceByMonth = buildSecurityPriceIndex(securitySnapshots);

  // Group holdings by account_id + yearMonth, take latest per holding
  const holdingsByAccountMonth: Map<string, Map<string, HoldingSnapshot>> = new Map();

  holdingSnapshots.forEach((holdingSnapshot) => {
    const { snapshot, holding } = holdingSnapshot;
    const { account_id, holding_id } = holding;
    if (!accounts.has(account_id)) return;

    const yearMonth = getYearMonthString(new LocalDate(snapshot.date));
    const key = `${account_id}:${yearMonth}`;

    if (!holdingsByAccountMonth.has(key)) {
      holdingsByAccountMonth.set(key, new Map());
    }
    const existing = holdingsByAccountMonth.get(key)!.get(holding_id);
    if (!existing || existing.snapshot.date < snapshot.date) {
      holdingsByAccountMonth.get(key)!.set(holding_id, holdingSnapshot);
    }
  });

  // Calculate total value per account per month
  const balanceData = new BalanceData();

  holdingsByAccountMonth.forEach((holdings, key) => {
    const [account_id, yearMonth] = key.split(":");
    const date = new LocalDate(`${yearMonth}-15`);

    let totalValue = 0;

    holdings.forEach(({ holding }) => {
      const price = getPriceForHolding(holding, securityPriceByMonth, yearMonth);
      totalValue += holding.quantity * price;
    });

    balanceData.set(account_id, date, totalValue);
  });

  return balanceData;
};

/**
 * Get per-security holdings value data with cost basis inference.
 * Keyed by holdingId for granular tracking and earnings breakdown.
 */
export const getHoldingsValueData = (
  holdingSnapshots: HoldingSnapshotDictionary,
  securitySnapshots: SecuritySnapshotDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
): HoldingsValueData => {
  const securityPriceByMonth = buildSecurityPriceIndex(securitySnapshots);
  const holdingsValueData = new HoldingsValueData();

  // Group by holdingId + yearMonth, take latest snapshot
  const snapshotsByHoldingMonth: Map<string, HoldingSnapshot> = new Map();

  holdingSnapshots.forEach((hs) => {
    const { snapshot, holding } = hs;
    const yearMonth = getYearMonthString(new LocalDate(snapshot.date));
    const key = `${holding.holding_id}:${yearMonth}`;

    const existing = snapshotsByHoldingMonth.get(key);
    if (!existing || existing.snapshot.date < snapshot.date) {
      snapshotsByHoldingMonth.set(key, hs);
    }
  });

  // Calculate value for each holding per month
  snapshotsByHoldingMonth.forEach((hs, key) => {
    const [holding_id, yearMonth] = key.split(":");
    const { snapshot, holding } = hs;
    const { security_id, quantity, cost_basis, account_id } = holding;
    const date = new LocalDate(`${yearMonth}-15`);

    // Get price with fallback
    const price = getPriceForHolding(holding, securityPriceByMonth, yearMonth);

    // Get cost basis with inference if invalid
    let finalCostBasis = cost_basis || 0;
    let costBasisInferred = false;

    if (!isCostBasisValid(holding)) {
      finalCostBasis = inferCostBasis(
        security_id,
        account_id,
        new LocalDate(snapshot.date),
        quantity,
        investmentTransactions,
        securityPriceByMonth,
      );
      costBasisInferred = true;
    }

    const summary = new HoldingValueSummary();
    summary.value = quantity * price;
    summary.costBasis = finalCostBasis;
    summary.quantity = quantity;
    summary.price = price;
    summary.security_id = security_id;
    summary.account_id = account_id;
    summary.costBasisInferred = costBasisInferred;

    holdingsValueData.set(holding_id, date, summary);
  });

  return holdingsValueData;
};

/**
 * Result of earnings calculation for a period.
 */
export interface EarningsResult {
  // Per-holding breakdown
  holdings: {
    holding_id: string;
    security_id: string;
    startValue: number;
    endValue: number;
    costBasis: number;
    costBasisInferred: boolean;
    unrealizedGain: number; // endValue - costBasis
    periodReturn: number; // endValue - startValue
  }[];
  // Totals
  totalStartValue: number;
  totalEndValue: number;
  totalCostBasis: number;
  totalUnrealizedGain: number;
  totalPeriodReturn: number;
}

/**
 * Calculate earnings for a given period and set of accounts.
 */
export const getEarningsForPeriod = (
  holdingsValueData: HoldingsValueData,
  accountIds: string[],
  startDate: Date,
  endDate: Date,
): EarningsResult => {
  const holdings: EarningsResult["holdings"] = [];
  let totalStartValue = 0,
    totalEndValue = 0,
    totalCostBasis = 0;

  holdingsValueData.forEach((history, holding_id) => {
    const startData = history.getNearest(startDate);
    const endData = history.getNearest(endDate);

    if (!endData || !accountIds.includes(endData.account_id)) return;

    const startValue = startData?.value || 0;
    const endValue = endData.value;
    const costBasis = endData.costBasis;

    holdings.push({
      holding_id,
      security_id: endData.security_id,
      startValue,
      endValue,
      costBasis,
      costBasisInferred: endData.costBasisInferred,
      unrealizedGain: endValue - costBasis,
      periodReturn: endValue - startValue,
    });

    totalStartValue += startValue;
    totalEndValue += endValue;
    totalCostBasis += costBasis;
  });

  return {
    holdings,
    totalStartValue,
    totalEndValue,
    totalCostBasis,
    totalUnrealizedGain: totalEndValue - totalCostBasis,
    totalPeriodReturn: totalEndValue - totalStartValue,
  };
};
