import { Dispatch, MouseEventHandler, SetStateAction, useMemo } from "react";
import { numberToCommaString } from "common";
import {
  BalanceChart,
  useAppContext,
  useReorder,
  HoldingValueSummary,
} from "client";
import { ChevronDownIcon, ChevronUpIcon, QuestionIcon } from "client/components";
import "./index.css";

export interface HoldingsCompositionProps {
  chart: BalanceChart;
  showTitle?: boolean;
  onClick?: MouseEventHandler<HTMLDivElement>;
  onSetOrder?: Dispatch<SetStateAction<string[]>>;
}

interface HoldingDisplay extends HoldingValueSummary {
  securityName: string;
  unrealizedGain: number;
  unrealizedGainPercent: number;
}

export const HoldingsComposition = ({
  chart,
  showTitle = true,
  onClick,
  onSetOrder,
}: HoldingsCompositionProps) => {
  const { data, calculations, viewDate } = useAppContext();
  const { securitySnapshots } = data;
  const { holdingsValueData } = calculations;
  const { name, configuration } = chart;
  const { account_ids } = configuration;

  // Build security name lookup from security snapshots
  const securityNames = useMemo(() => {
    const names = new Map<string, string>();
    securitySnapshots.forEach(({ security }) => {
      const displayName = security.name || security.ticker_symbol || security.security_id;
      if (displayName) {
        names.set(security.security_id, displayName);
      }
    });
    return names;
  }, [securitySnapshots]);

  const {
    onDragStart,
    onDragEnd,
    onDragEnter,
    onGotPointerCapture,
    onTouchHandleStart,
    onTouchHandleEnd,
    onPointerEnter,
    isDragging,
  } = useReorder(chart.id, onSetOrder);

  const date = viewDate.getEndDate();

  // Get all holdings for the configured accounts at the current date
  const holdings = useMemo(() => {
    const result: HoldingDisplay[] = [];

    account_ids.forEach((accountId) => {
      const accountHoldings = holdingsValueData.getHoldingsForAccount(accountId, date);
      accountHoldings.forEach((holding) => {
        const securityName = securityNames.get(holding.security_id) || holding.security_id;
        const unrealizedGain = holding.value - holding.costBasis;
        const unrealizedGainPercent =
          holding.costBasis > 0 ? (unrealizedGain / holding.costBasis) * 100 : 0;

        result.push({
          ...holding,
          securityName,
          unrealizedGain,
          unrealizedGainPercent,
        });
      });
    });

    // Sort by value descending
    result.sort((a, b) => b.value - a.value);
    return result;
  }, [account_ids, holdingsValueData, date, securityNames]);

  // Calculate totals
  const totals = useMemo(() => {
    let totalValue = 0;
    let totalCostBasis = 0;

    holdings.forEach((h) => {
      totalValue += h.value;
      totalCostBasis += h.costBasis;
    });

    const totalUnrealizedGain = totalValue - totalCostBasis;
    const totalUnrealizedGainPercent =
      totalCostBasis > 0 ? (totalUnrealizedGain / totalCostBasis) * 100 : 0;

    return {
      totalValue,
      totalCostBasis,
      totalUnrealizedGain,
      totalUnrealizedGainPercent,
    };
  }, [holdings]);

  // Build pie chart data
  const pieData = useMemo(() => {
    if (totals.totalValue === 0) return [];
    return holdings.map((h) => ({
      name: h.securityName,
      value: h.value,
      percent: (h.value / totals.totalValue) * 100,
    }));
  }, [holdings, totals.totalValue]);

  const classes = ["HoldingsComposition"];
  if (isDragging) classes.push("dragging");

  const formatGain = (gain: number, percent: number) => {
    const sign = gain >= 0 ? "+" : "";
    return `${sign}$${numberToCommaString(Math.abs(gain), 0)} (${sign}${percent.toFixed(1)}%)`;
  };

  const getGainClass = (gain: number) => {
    if (gain > 0) return "positive";
    if (gain < 0) return "negative";
    return "";
  };

  if (holdings.length === 0) {
    return (
      <div className={classes.join(" ")} onClick={onClick}>
        {showTitle && (
          <h3 className="title">
            <span>{name} - Holdings</span>
          </h3>
        )}
        <div className="emptyMessage">No holdings data available for selected accounts</div>
      </div>
    );
  }

  return (
    <div
      className={classes.join(" ")}
      onClick={onClick}
      draggable={true}
      onDragStart={onDragStart}
      onDragEnter={onDragEnter}
      onPointerEnter={onPointerEnter}
      onDragEnd={onDragEnd}
    >
      {showTitle && (
        <h3 className="title">
          <span>{name} - Holdings</span>
          <button
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onTouchStart={onTouchHandleStart}
            onTouchEnd={onTouchHandleEnd}
            onGotPointerCapture={onGotPointerCapture}
            style={{ touchAction: "none" }}
          >
            <div className="reorderIcon">
              <ChevronUpIcon size={8} />
              <ChevronDownIcon size={8} />
            </div>
          </button>
        </h3>
      )}

      <div className="composition">
        {/* Pie/Donut representation */}
        <div className="pieContainer">
          <svg viewBox="0 0 100 100" className="pie">
            {pieData.reduce(
              (acc, item, i) => {
                const startAngle = acc.currentAngle;
                const angle = (item.percent / 100) * 360;
                const endAngle = startAngle + angle;

                // Convert to radians
                const startRad = ((startAngle - 90) * Math.PI) / 180;
                const endRad = ((endAngle - 90) * Math.PI) / 180;

                // Calculate arc path
                const x1 = 50 + 40 * Math.cos(startRad);
                const y1 = 50 + 40 * Math.sin(startRad);
                const x2 = 50 + 40 * Math.cos(endRad);
                const y2 = 50 + 40 * Math.sin(endRad);

                const largeArc = angle > 180 ? 1 : 0;

                const pathD = `M 50 50 L ${x1} ${y1} A 40 40 0 ${largeArc} 1 ${x2} ${y2} Z`;

                // Generate color based on index
                const hue = (i * 137.508) % 360; // Golden angle for good distribution
                const color = `hsl(${hue}, 60%, 55%)`;

                acc.paths.push(
                  <path key={i} d={pathD} fill={color} stroke="white" strokeWidth="0.5">
                    <title>
                      {item.name}: ${numberToCommaString(item.value, 0)} ({item.percent.toFixed(1)}%)
                    </title>
                  </path>,
                );
                acc.currentAngle = endAngle;
                return acc;
              },
              { paths: [] as JSX.Element[], currentAngle: 0 },
            ).paths}
            {/* Inner circle for donut effect */}
            <circle cx="50" cy="50" r="25" fill="white" />
          </svg>
          <div className="pieCenter">
            <div className="totalValue">${numberToCommaString(totals.totalValue, 0)}</div>
            <div className={`totalGain ${getGainClass(totals.totalUnrealizedGain)}`}>
              {formatGain(totals.totalUnrealizedGain, totals.totalUnrealizedGainPercent)}
            </div>
          </div>
        </div>

        {/* Holdings table */}
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
            {holdings.map((holding, i) => (
              <tr key={`${holding.security_id}-${i}`}>
                <td className="securityName">
                  {holding.securityName}
                  {holding.costBasisInferred && (
                    <span
                      className="inferredIcon"
                      title="Cost basis was estimated from transaction history"
                    >
                      <QuestionIcon size={12} />
                    </span>
                  )}
                </td>
                <td className="value">${numberToCommaString(holding.value, 0)}</td>
                <td className="costBasis">${numberToCommaString(holding.costBasis, 0)}</td>
                <td className={`gain ${getGainClass(holding.unrealizedGain)}`}>
                  {formatGain(holding.unrealizedGain, holding.unrealizedGainPercent)}
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="totalsRow">
              <td>Total</td>
              <td className="value">${numberToCommaString(totals.totalValue, 0)}</td>
              <td className="costBasis">${numberToCommaString(totals.totalCostBasis, 0)}</td>
              <td className={`gain ${getGainClass(totals.totalUnrealizedGain)}`}>
                {formatGain(totals.totalUnrealizedGain, totals.totalUnrealizedGainPercent)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
};
