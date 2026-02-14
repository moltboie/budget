import { useMemo } from "react";
import { AccountSubtype, AccountType } from "plaid";
import { getYearMonthString, LocalDate, ViewDate } from "common";
import {
  Account,
  AccountSnapshot,
  InvestmentTransaction,
  Transaction,
  GraphInput,
  useAppContext,
  AccountDictionary,
  AccountSnapshotDictionary,
  HoldingSnapshotDictionary,
  SecuritySnapshotDictionary,
  InvestmentTransactionDictionary,
  TransactionDictionary,
  BalanceData,
} from "client";
import { getBalanceDataFromHoldingSnapshots } from "./holdings";

export const getAccountBalance = (account: Account) => {
  const balanceCurrent = account.balances.current || 0;
  const balanceAvailalbe = account.balances.available || 0;
  let value = 0;
  if (account.type === AccountType.Investment) {
    if (account.subtype === AccountSubtype.CryptoExchange) value = balanceCurrent;
    else value = balanceCurrent + balanceAvailalbe;
  } else {
    value = balanceCurrent;
  }
  return value;
};

const getBalanceDataFromTransactions = (
  accounts: AccountDictionary,
  transactions: TransactionDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
): BalanceData => {
  const balanceData = new BalanceData();

  const today = new Date();
  accounts.forEach((a) => balanceData.set(a.id, today, getAccountBalance(a)));

  // first aggregates transactions to sum amounts for each period
  const translate = (t: Transaction | InvestmentTransaction) => {
    const isInvestment = t instanceof InvestmentTransaction;
    const authorized_date = !isInvestment ? t.authorized_date : undefined;
    const { account_id, date, amount } = t;
    if (!accounts.has(account_id)) return;
    const transactionDate = new LocalDate(authorized_date || date);
    if (today < transactionDate) return;
    const previousMonthDate = new ViewDate("month", transactionDate).previous().getEndDate();
    if (isInvestment) {
      const { price, quantity } = t as InvestmentTransaction;
      balanceData.add(account_id, previousMonthDate, -(price * quantity));
    } else {
      balanceData.add(account_id, previousMonthDate, amount);
    }
  };

  transactions.forEach(translate);
  investmentTransactions.forEach(translate);

  // then incrementally adds them up
  for (const [accountId] of accounts) {
    const history = balanceData.get(accountId);
    const { startDate, endDate } = history;
    if (!startDate || !endDate) continue;
    while (startDate.getEndDate() <= endDate.getEndDate()) {
      const amount = history.get(endDate.getEndDate()) || 0;
      const laterAmount = history.get(endDate.clone().next().getEndDate()) || 0;
      history.set(endDate.getEndDate(), laterAmount + amount);
      endDate.previous();
    }
  }

  return balanceData;
};

const getBalanceDataFromSnapshots = (
  accounts: AccountDictionary,
  accountSnapshots: AccountSnapshotDictionary,
): BalanceData => {
  const snapshotHistory: { [yearMonth: string]: { [account_id: string]: AccountSnapshot } } = {};

  const today = new Date();

  // first aggregates snapshots to take the latest snapshot for each period
  accountSnapshots.forEach((accountSnapshot) => {
    const { snapshot, account } = accountSnapshot;
    const { date } = snapshot;
    if (!account.balances.current && account.balances.current !== 0) return;
    const snapshotDate = new LocalDate(date);
    if (today < snapshotDate) return;
    const key = getYearMonthString(snapshotDate);
    const existing = snapshotHistory[key];
    if (existing) {
      if (!existing[account.id] || existing[account.id].snapshot.date < date) {
        existing[account.id] = accountSnapshot;
      }
    } else {
      snapshotHistory[key] = { [account.id]: accountSnapshot };
    }
  });

  // then transforms it into balance data
  const balanceData = new BalanceData();
  Object.values(snapshotHistory).forEach((accountSnapshots) => {
    for (const [accountId] of accounts) {
      const accountSnapshot = accountSnapshots[accountId];
      if (accountSnapshot) {
        const snapshotDate = new LocalDate(accountSnapshot.snapshot.date);
        const snapshotBalance = getAccountBalance(accountSnapshot.account);
        balanceData.set(accountId, snapshotDate, snapshotBalance);
      }
    }
  });

  // makes sure today's balance takes priority over snapshots.
  accounts.forEach((a) => balanceData.set(a.id, today, getAccountBalance(a)));

  return balanceData;
};

/**
 * Get balance data with 3-tier fallback:
 * 1. Account Snapshot (highest priority)
 * 2. Holding Snapshot (calculated from holdings value)
 * 3. Transactions (lowest priority)
 */
export const getBalanceData = (
  accounts: AccountDictionary,
  accountSnapshots: AccountSnapshotDictionary,
  holdingSnapshots: HoldingSnapshotDictionary,
  securitySnapshots: SecuritySnapshotDictionary,
  transactions: TransactionDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
) => {
  // Tier 3: Transaction-based balance (lowest priority)
  const transactionBasedData = getBalanceDataFromTransactions(
    accounts,
    transactions,
    investmentTransactions,
  );

  // Tier 2: Holding-snapshot-based balance (medium priority)
  const holdingBasedData = getBalanceDataFromHoldingSnapshots(
    accounts,
    holdingSnapshots,
    securitySnapshots,
  );

  // Tier 1: Account-snapshot-based balance (highest priority)
  const snapshotBasedData = getBalanceDataFromSnapshots(accounts, accountSnapshots);

  const mergedData = new BalanceData();

  accounts.forEach(({ id, graphOptions }) => {
    // Find the earliest and latest dates across all data sources
    const dates: Date[] = [];
    const transactionHistory = transactionBasedData.get(id);
    const holdingHistory = holdingBasedData.get(id);
    const snapshotHistory = snapshotBasedData.get(id);

    if (transactionHistory.startDate) dates.push(transactionHistory.startDate.getEndDate());
    if (holdingHistory.startDate) dates.push(holdingHistory.startDate.getEndDate());
    if (snapshotHistory.startDate) dates.push(snapshotHistory.startDate.getEndDate());

    if (dates.length === 0) return;

    const startDate = new ViewDate("month", new Date(Math.min(...dates.map((d) => d.getTime()))));

    const endDates: Date[] = [];
    if (transactionHistory.endDate) endDates.push(transactionHistory.endDate.getEndDate());
    if (holdingHistory.endDate) endDates.push(holdingHistory.endDate.getEndDate());
    if (snapshotHistory.endDate) endDates.push(snapshotHistory.endDate.getEndDate());

    if (endDates.length === 0) return;

    const endDate = new ViewDate(
      "month",
      new Date(Math.max(...endDates.map((d) => d.getTime()))),
    );

    const { useTransactions = true, useSnapshots = true } = graphOptions;

    let previouslyUsedBalance = 0;
    while (startDate.getEndDate() <= endDate.getEndDate()) {
      const date = startDate.getEndDate();
      let balance: number | undefined;

      // Priority 1: Account snapshot
      if (useSnapshots) {
        const snapshotBalance = snapshotBasedData.get(id, date);
        if (snapshotBalance !== undefined) {
          balance = snapshotBalance;
        }
      }

      // Priority 2: Holding snapshot (calculated from holdings value)
      if (balance === undefined && useSnapshots) {
        const holdingBalance = holdingBasedData.get(id, date);
        if (holdingBalance !== undefined) {
          balance = holdingBalance;
        }
      }

      // Priority 3: Transactions
      if (balance === undefined && useTransactions) {
        const transactionBalance = transactionBasedData.get(id, date);
        if (transactionBalance !== undefined) {
          balance = transactionBalance;
        }
      }

      // Fallback to previous value
      if (balance === undefined) {
        balance = previouslyUsedBalance;
      }

      mergedData.set(id, date, balance);
      previouslyUsedBalance = balance;
      startDate.next();
    }
  });

  return mergedData;
};

interface UseAccountGraphOptions {
  startDate?: Date;
  viewDate?: ViewDate;
  useLengthFixer?: boolean;
}

export const useAccountGraph = (accounts: Account[], options: UseAccountGraphOptions = {}) => {
  const { viewDate, calculations } = useAppContext();
  const { balanceData } = calculations;
  const { viewDate: inputViewDate, startDate, useLengthFixer = true } = options;

  const graphViewDate = useMemo(() => {
    if (inputViewDate) return inputViewDate;
    return new ViewDate(viewDate.getInterval());
  }, [viewDate, inputViewDate]);

  const { graphData, cursorAmount } = useMemo(() => {
    const flattened: number[] = [];
    accounts.forEach(({ id }) => {
      const balanceArray = balanceData.get(id).toArray(graphViewDate);
      const maxLength = startDate
        ? graphViewDate.getSpanFrom(startDate) + 1
        : balanceArray.length || 0;

      for (let i = 0; i < maxLength; i++) {
        if (flattened[i] === undefined) flattened[i] = 0;
        flattened[i] += balanceArray[i] || 0;
      }
    });

    const { length } = flattened;

    const lengthFixer = useLengthFixer ? 3 - ((length - 1) % 3) : 0;
    flattened.push(...new Array(lengthFixer));

    const sequence = flattened.reverse();

    const viewDateIndex = graphViewDate.getSpanFrom(viewDate.getEndDate()) - lengthFixer;
    const cursorIndex = length - 1 - viewDateIndex;
    const cursorAmount = sequence[cursorIndex] as number | undefined;
    const points = [];
    if (cursorAmount === undefined) {
      const arbitraryAmount = sequence[cursorIndex - 1] || sequence[cursorIndex + 1] || 0;
      points.push({ point: { value: arbitraryAmount, index: cursorIndex }, color: "#0970" });
    } else {
      points.push({ point: { value: cursorAmount, index: cursorIndex }, color: "#097" });
    }

    const graphData: GraphInput = { lines: [{ sequence, color: "#097" }], points };

    return { graphData, cursorAmount };
  }, [accounts, balanceData, startDate, useLengthFixer, graphViewDate, viewDate]);

  return { graphViewDate, graphData, cursorAmount };
};
