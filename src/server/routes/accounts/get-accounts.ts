import { JSONAccount, JSONHolding, JSONItem, JSONSecurity } from "common";
import { Route, searchAccounts, searchItems, getHoldings, searchSecuritiesById } from "server";

export interface AccountsGetResponse {
  items: JSONItem[];
  accounts: JSONAccount[];
  holdings: JSONHolding[];
  securities: JSONSecurity[];
}

export const getAccountsRoute = new Route<AccountsGetResponse>("GET", "/accounts", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  const [items, accounts, holdings] = await Promise.all([
    searchItems(user),
    searchAccounts(user),
    getHoldings(user),
  ]);

  // Get unique security IDs from holdings and fetch their details
  const securityIds = [...new Set(holdings.map((h) => h.security_id))];
  const securities = await searchSecuritiesById(securityIds);

  const body = { items, accounts, holdings, securities };

  return { status: "success", body };
});
