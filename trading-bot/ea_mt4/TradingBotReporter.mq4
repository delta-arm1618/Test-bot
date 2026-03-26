//+------------------------------------------------------------------+
//|  TradingBotReporter.mq4                                          |
//|  Trading Competition Bot — Free MT4/MT5 Tracker                  |
//|  Sends account metrics to your bot's HTTP webhook every N minutes |
//+------------------------------------------------------------------+

#property copyright "Trading Competition Bot"
#property version   "1.00"
#property strict

//── Input Parameters ────────────────────────────────────────────────
extern string WebhookURL    = "http://your-server:3000/webhook/ea";  // Your bot's URL
extern string WebhookSecret = "your_http_secret_here";               // Must match HTTP_SECRET in .env
extern string AccountID     = "";                                     // Your account ID (from /account link)
extern int    ReportInterval = 15;                                    // Minutes between reports
extern bool   ReportOnClose  = true;                                  // Send immediately when a trade closes

//── State Variables ──────────────────────────────────────────────────
datetime lastReportTime  = 0;
int      lastTradesTotal = 0;

//+------------------------------------------------------------------+
//| Expert initialization                                             |
//+------------------------------------------------------------------+
int OnInit() {
   if (AccountID == "") {
      Print("[TradingBotReporter] ERROR: AccountID is empty! Set it to your account ID from /account link");
      return INIT_PARAMETERS_INCORRECT;
   }
   if (WebhookSecret == "your_http_secret_here") {
      Print("[TradingBotReporter] WARNING: Using default secret — change WebhookSecret to match your bot!");
   }
   Print("[TradingBotReporter] Initialized. Reporting to: ", WebhookURL);
   SendReport();  // Send initial report on attach
   return INIT_SUCCEEDED;
}

//+------------------------------------------------------------------+
//| Expert tick function                                              |
//+------------------------------------------------------------------+
void OnTick() {
   // Check if interval elapsed
   if (TimeCurrent() - lastReportTime >= ReportInterval * 60) {
      SendReport();
   }
}

//+------------------------------------------------------------------+
//| Called when a trade is closed                                     |
//+------------------------------------------------------------------+
void OnTrade() {
   if (!ReportOnClose) return;
   int currentTotal = OrdersHistoryTotal();
   if (currentTotal != lastTradesTotal) {
      lastTradesTotal = currentTotal;
      SendReport();
   }
}

//+------------------------------------------------------------------+
//| Build and send the JSON report                                    |
//+------------------------------------------------------------------+
void SendReport() {
   lastReportTime = TimeCurrent();

   double balance    = AccountBalance();
   double equity     = AccountEquity();
   double profit     = AccountProfit();
   double freeMargin = AccountFreeMargin();

   // ── Compute stats from trade history ─────────────────────────────
   int    tradesTotal = OrdersHistoryTotal();
   int    tradesWon   = 0;
   double grossProfit = 0;
   double grossLoss   = 0;
   double maxDD       = 0;
   double peakBalance = balance;

   string closedTradesJSON = "";
   int    closedCount      = 0;

   // Daily PnL tracking (last 7 days)
   double dailyPnl[7];
   string dailyPnlStr = "";
   ArrayInitialize(dailyPnl, 0);

   for (int i = 0; i < tradesTotal; i++) {
      if (!OrderSelect(i, SELECT_BY_POS, MODE_HISTORY)) continue;
      if (OrderType() > OP_SELL) continue;  // Skip non-market orders

      double orderProfit = OrderProfit() + OrderSwap() + OrderCommission();

      if (orderProfit > 0) {
         tradesWon++;
         grossProfit += orderProfit;
      } else {
         grossLoss += MathAbs(orderProfit);
      }

      // Track drawdown
      peakBalance = MathMax(peakBalance, AccountBalance() + orderProfit);
      double dd = (peakBalance - AccountBalance()) / MathMax(peakBalance, 1);
      maxDD = MathMax(maxDD, dd);

      // Collect daily PnL (last 7 days)
      int daysAgo = (int)((TimeCurrent() - OrderCloseTime()) / 86400);
      if (daysAgo >= 0 && daysAgo < 7) {
         dailyPnl[daysAgo] += orderProfit;
      }

      // Build closed trades array (last 20)
      if (closedCount < 20) {
         string tradeStr = StringFormat(
            "{\"ticket\":%d,\"symbol\":\"%s\",\"direction\":\"%s\","
            "\"open_time\":\"%s\",\"close_time\":\"%s\","
            "\"open_price\":%.5f,\"close_price\":%.5f,"
            "\"lots\":%.2f,\"profit\":%.2f,\"profit_pct\":%.4f}",
            OrderTicket(),
            OrderSymbol(),
            OrderType() == OP_BUY ? "buy" : "sell",
            TimeToStr(OrderOpenTime()),
            TimeToStr(OrderCloseTime()),
            OrderOpenPrice(),
            OrderClosePrice(),
            OrderLots(),
            orderProfit,
            balance > 0 ? orderProfit / balance * 100 : 0
         );
         if (closedCount > 0) closedTradesJSON += ",";
         closedTradesJSON += tradeStr;
         closedCount++;
      }
   }

   // Build daily PnL JSON array
   for (int d = 0; d < 7; d++) {
      if (d > 0) dailyPnlStr += ",";
      dailyPnlStr += DoubleToStr(dailyPnl[d], 2);
   }

   double winRate    = tradesTotal > 0 ? (double)tradesWon / tradesTotal : 0;
   double profitFact = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 99 : 1);

   // ── Build JSON payload ────────────────────────────────────────────
   string json = StringFormat(
      "{"
      "\"secret\":\"%s\","
      "\"account_id\":\"%s\","
      "\"balance\":%.2f,"
      "\"equity\":%.2f,"
      "\"profit\":%.2f,"
      "\"free_margin\":%.2f,"
      "\"trades_total\":%d,"
      "\"trades_won\":%d,"
      "\"max_drawdown_abs\":%.2f,"
      "\"gross_profit\":%.2f,"
      "\"gross_loss\":%.2f,"
      "\"profit_factor\":%.4f,"
      "\"daily_pnl\":[%s],"
      "\"closed_trades\":[%s]"
      "}",
      WebhookSecret,
      AccountID,
      balance,
      equity,
      profit,
      freeMargin,
      tradesTotal,
      tradesWon,
      maxDD * balance,  // absolute drawdown in currency
      grossProfit,
      grossLoss,
      profitFact,
      dailyPnlStr,
      closedTradesJSON
   );

   // ── Send HTTP POST ────────────────────────────────────────────────
   string headers = "Content-Type: application/json\r\n";
   char   postData[];
   char   result[];
   string resultHeaders;

   StringToCharArray(json, postData, 0, StringLen(json));

   int timeout = 5000; // 5 second timeout
   int res = WebRequest("POST", WebhookURL, headers, timeout, postData, result, resultHeaders);

   if (res == 200) {
      Print("[TradingBotReporter] ✅ Report sent. Balance: ", balance, " | Trades: ", tradesTotal, " | WinRate: ", DoubleToStr(winRate * 100, 1), "%");
   } else {
      Print("[TradingBotReporter] ❌ HTTP Error: ", res, " | Enable WebRequest in Tools > Options > Expert Advisors");
   }
}
//+------------------------------------------------------------------+
