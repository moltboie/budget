import { ItemProvider, ONE_HOUR } from "common";
import { getAllItems, logger, updateItemSyncStatus } from "server";
import { sendAlarm } from "server/lib/alarm";
import { syncPlaidAccounts, syncPlaidTransactions } from "./sync-plaid";
import { syncSimpleFinData } from "./sync-simple-fin";
import { logger } from "../logger";

let isSyncing = false;

export const scheduledSync = async () => {
  if (isSyncing) {
    logger.warn("Skipping scheduled sync — previous sync still running");
    setTimeout(scheduledSync, ONE_HOUR);
    return;
  }
  isSyncing = true;
        logger.info("Synced Plaid item", {
          itemId: item_id,
          accountsUpdated: accountsCount,
          transactionsUpdated: transactionsCount,
          syncError,
      }
    }
  } catch (err) {
    logger.error("Error occurred during scheduled sync", {}, err);
    sendAlarm("Scheduled Sync Failed", `**Error:** ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
  } finally {
    isSyncing = false;
    logger.info("Scheduled sync completed");
    setTimeout(scheduledSync, ONE_HOUR);
  }
};
