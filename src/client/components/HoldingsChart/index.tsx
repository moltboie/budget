import { useMemo } from "react";
import { numberToCommaString, getYearMonthString, LocalDate } from "common";
import { colors, Donut, DonutData, useAppContext, Security } from "client";
import "./index.css";

interface HoldingDisplay {
  holding_id: string;
  security_id: string;
  ticker_symbol: string;
  name: string;
  value: number;
  previousValue: number;
  costBasis: number;
  costBasisInferred: boolean;
  gainLoss: number; // current value - previous value
  gainLossPercent: number;
}

interface HoldingsChartProps {
  accountIds: string[];
}

export const HoldingsChart = ({ accountIds }: HoldingsChartProps) => {
  const { data, calculations, viewDate } = useAppContext();
  const { holdingsValueData } = calculations;
  const { securitySnapshots } = data;

  const { holdings, totalValue, totalPreviousValue, totalGainLoss, totalGainLossPercent } =
    useMemo(() => {
      const currentDate = viewDate.getEndDate();
      // Clone viewDate and go to previous period to get previous date
      const previousViewDate = viewDate.clone().previous();
      const previousDate = previousViewDate.getEndDate();
      
      const currentYearMonth = getYearMonthString(new LocalDate(currentDate));
      const previousYearMonth = getYearMonthString(new LocalDate(previousDate));

      console.group("[HoldingsChart] Calculation Debug");
      console.log("View Date:", viewDate);
      console.log("Current Date:", currentDate, "YearMonth:", currentYearMonth);
      console.log("Previous Date:", previousDate, "YearMonth:", previousYearMonth);
      console.log("Account IDs:", accountIds);
      console.log("Holdings Value Data size:", holdingsValueData.size);
      console.log("Security Snapshots size:", securitySnapshots.size);

      // Build security lookup map for ticker symbols
      const securityMap = new Map<string, Security>();
      securitySnapshots.forEach(({ security }) => {
        if (!securityMap.has(security.security_id)) {
          securityMap.set(security.security_id, security);
        }
      });
      console.log("Security Map size:", securityMap.size);
      console.log("Securities:", Array.from(securityMap.entries()).map(([id, s]) => ({
        id,
        ticker: s.ticker_symbol,
        name: s.name
      })));

      const holdingsDisplay: HoldingDisplay[] = [];
      let totalValue = 0;
      let totalPreviousValue = 0;

      holdingsValueData.forEach((history, holding_id) => {
        const currentData = history.get(currentDate);
        const previousData = history.get(previousDate);

        console.log(`[Holding ${holding_id}]`);
        console.log("  Current data:", currentData);
        console.log("  Previous data:", previousData);

        // Skip if no current data or not in selected accounts
        if (!currentData) {
          console.log("  -> Skipped: no current data");
          return;
        }
        
        if (!accountIds.includes(currentData.account_id)) {
          console.log("  -> Skipped: account_id not in selected accounts");
          return;
        }

        const security = securityMap.get(currentData.security_id);
        console.log("  Security lookup:", security);

        const value = currentData.value;
        const previousValue = previousData?.value || 0;
        const gainLoss = value - previousValue;
        const gainLossPercent = previousValue !== 0 ? (gainLoss / previousValue) * 100 : 0;

        console.log("  Calculated values:", {
          value,
          previousValue,
          gainLoss,
          gainLossPercent,
          costBasis: currentData.costBasis,
        });

        holdingsDisplay.push({
          holding_id,
          security_id: currentData.security_id,
          ticker_symbol: security?.ticker_symbol || currentData.security_id.substring(0, 8) + "...",
          name: security?.name || "Unknown Security",
          value,
          previousValue,
          costBasis: currentData.costBasis,
          costBasisInferred: currentData.costBasisInferred,
          gainLoss,
          gainLossPercent,
        });

        totalValue += value;
        totalPreviousValue += previousValue;
      });

      // Sort by value descending
      holdingsDisplay.sort((a, b) => b.value - a.value);

      const totalGainLoss = totalValue - totalPreviousValue;
      const totalGainLossPercent =
        totalPreviousValue !== 0 ? (totalGainLoss / totalPreviousValue) * 100 : 0;

      console.log("Final holdings:", holdingsDisplay);
      console.log("Totals:", { totalValue, totalPreviousValue, totalGainLoss, totalGainLossPercent });
      console.groupEnd();

      return {
        holdings: holdingsDisplay,
        totalValue,
        totalPreviousValue,
        totalGainLoss,
        totalGainLossPercent,
      };
    }, [holdingsValueData, securitySnapshots, accountIds, viewDate]);

  if (holdings.length === 0) {
    return null;
  }

  const donutData: DonutData[] = holdings.map((h, i) => ({
    id: h.holding_id,
    value: h.value,
    color: colors[i % colors.length],
    label: `${h.ticker_symbol}: $${numberToCommaString(h.value, 0)} (${h.value > 0 ? ((h.value / totalValue) * 100).toFixed(1) : 0}%)`,
  }));

  const formatGainLoss = (amount: number, percent: number) => {
    const sign = amount >= 0 ? "+" : "";
    return `${sign}$${numberToCommaString(Math.abs(amount), 0)} (${sign}${percent.toFixed(1)}%)`;
  };

  return (
    <div className="HoldingsChart">
      <div className="chartSection">
        <div className="donutContainer">
          <Donut data={donutData} radius={60} thickness={12} />
          <div className="donutLabel">
            <div className="totalValue">${numberToCommaString(totalValue, 0)}</div>
            <div className={`gainLoss ${totalGainLoss >= 0 ? "positive" : "negative"}`}>
              {formatGainLoss(totalGainLoss, totalGainLossPercent)}
            </div>
          </div>
        </div>

        <table className="holdingsTable">
          <thead>
            <tr>
              <th>Security</th>
              <th>Value</th>
              <th>Cost Basis</th>
              <th>Gain/Loss</th>
            </tr>
          </thead>
          <tbody>
            {holdings.map((h) => (
              <tr key={h.holding_id}>
                <td className="security">
                  {h.ticker_symbol}
                  {h.costBasisInferred && (
                    <span className="inferred" title="Cost basis was estimated from transaction history">
                      ⓘ
                    </span>
                  )}
                </td>
                <td>${numberToCommaString(h.value, 0)}</td>
                <td>${numberToCommaString(h.costBasis, 0)}</td>
                <td className={h.gainLoss >= 0 ? "positive" : "negative"}>
                  {formatGainLoss(h.gainLoss, h.gainLossPercent)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="totalRow">
              <td>Total</td>
              <td>${numberToCommaString(totalValue, 0)}</td>
              <td>${numberToCommaString(holdings.reduce((sum, h) => sum + h.costBasis, 0), 0)}</td>
              <td className={totalGainLoss >= 0 ? "positive" : "negative"}>
                {formatGainLoss(totalGainLoss, totalGainLossPercent)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
};
