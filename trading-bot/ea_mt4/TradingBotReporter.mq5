//+------------------------------------------------------------------+
//|  TradingBotReporter.mq5                                          |
//|  Trading Competition Bot — Free MT5 Tracker                      |
//+------------------------------------------------------------------+

#property copyright "Trading Competition Bot"
#property version   "1.00"

#include <Trade\Trade.mqh>

//── Input Parameters ────────────────────────────────────────────────
input string WebhookURL     = "http://your-server:3000/webhook/ea";
input string WebhookSecret  = "your_http_secret_here";
input string AccountID      = "";
input int    ReportInterval = 15;   // Minutes between reports
input bool   ReportOnClose  = true;

//── State ─────────────────────────────────────────────────────────
datetime lastReportTime = 0;
int      lastDeals      = 0;

//+------------------------------------------------------------------+
int OnInit() {
   if (AccountID == "") {
      Print("[TradingBotReporter] ERROR: AccountID is empty!");
      return INIT_PARAMETERS_INCORRECT;
   }
   Print("[TradingBotReporter] Initialized. Reporting to: ", WebhookURL);
   SendReport();
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
void OnTick() {
   if (TimeCurrent() - lastReportTime >= ReportInterval * 60) {
      SendReport();
   }
}

//+------------------------------------------------------------------+
void OnTradeTransaction(const MqlTradeTransaction &trans,
                        const MqlTradeRequest &request,
                        const MqlTradeResult &result) {
   if (!ReportOnClose) return;
   if (trans.type == TRADE_TRANSACTION_DEAL_ADD) {
      SendReport();
   }
}

//+------------------------------------------------------------------+
void SendReport() {
   lastReportTime = TimeCurrent();

   double balance = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity  = AccountInfoDouble(ACCOUNT_EQUITY);
   double profit  = AccountInfoDouble(ACCOUNT_PROFIT);

   // Gather history stats
   HistorySelect(0, TimeCurrent());
   int    total      = HistoryDealsTotal();
   int    won        = 0;
   double gProfit    = 0;
   double gLoss      = 0;
   double maxDD      = 0;
   double peak       = balance;
   double dailyPnl[7];
   ArrayInitialize(dailyPnl, 0);

   string closedJSON = "";
   int    closedCount = 0;

   for (int i = 0; i < total; i++) {
      ulong ticket = HistoryDealGetTicket(i);
      if (ticket == 0) continue;
      if (HistoryDealGetInteger(ticket, DEAL_ENTRY) != DEAL_ENTRY_OUT) continue;

      double dealProfit = HistoryDealGetDouble(ticket, DEAL_PROFIT)
                        + HistoryDealGetDouble(ticket, DEAL_SWAP)
                        + HistoryDealGetDouble(ticket, DEAL_COMMISSION);

      if (dealProfit >= 0) { won++; gProfit += dealProfit; }
      else                 { gLoss += MathAbs(dealProfit); }

      // Daily PnL
      datetime closeTime = (datetime)HistoryDealGetInteger(ticket, DEAL_TIME);
      int daysAgo = (int)((TimeCurrent() - closeTime) / 86400);
      if (daysAgo >= 0 && daysAgo < 7) dailyPnl[daysAgo] += dealProfit;

      // Closed trades JSON
      if (closedCount < 20) {
         string sym  = HistoryDealGetString(ticket, DEAL_SYMBOL);
         long   type = HistoryDealGetInteger(ticket, DEAL_TYPE);
         if (closedCount > 0) closedJSON += ",";
         closedJSON += StringFormat(
            "{\"ticket\":%d,\"symbol\":\"%s\",\"direction\":\"%s\","
            "\"profit\":%.2f,\"profit_pct\":%.4f}",
            (int)ticket, sym,
            type == DEAL_TYPE_BUY ? "buy" : "sell",
            dealProfit,
            balance > 0 ? dealProfit / balance * 100 : 0
         );
         closedCount++;
      }
   }

   string dailyStr = "";
   for (int d = 0; d < 7; d++) {
      if (d > 0) dailyStr += ",";
      dailyStr += DoubleToString(dailyPnl[d], 2);
   }

   double winRate = total > 0 ? (double)won / total : 0;
   double pf      = gLoss > 0 ? gProfit / gLoss : (gProfit > 0 ? 99 : 1);

   string json = StringFormat(
      "{\"secret\":\"%s\",\"account_id\":\"%s\","
      "\"balance\":%.2f,\"equity\":%.2f,\"profit\":%.2f,"
      "\"trades_total\":%d,\"trades_won\":%d,"
      "\"max_drawdown_abs\":%.2f,\"gross_profit\":%.2f,"
      "\"gross_loss\":%.2f,\"profit_factor\":%.4f,"
      "\"daily_pnl\":[%s],\"closed_trades\":[%s]}",
      WebhookSecret, AccountID,
      balance, equity, profit,
      total, won,
      maxDD, gProfit, gLoss, pf,
      dailyStr, closedJSON
   );

   char  postData[];
   char  result_arr[];
   string resultHeaders;
   StringToCharArray(json, postData, 0, StringLen(json));

   int res = WebRequest(
      "POST", WebhookURL,
      "Content-Type: application/json\r\n",
      5000, postData, result_arr, resultHeaders
   );

   if (res == 200)
      Print("[TradingBotReporter] ✅ Report sent | Trades:", total, " WR:", DoubleToString(winRate*100,1), "%");
   else
      Print("[TradingBotReporter] ❌ HTTP error:", res);
}
//+------------------------------------------------------------------+
