import axios from 'axios';

const TRADE_API_URL = "http://localhost:3000/api/v1/trading/trade"; // Adjust based on your setup
const API_URL = "http://localhost:3000/api/v1/trading/new_trade";
const generateMockTrades = (numTrades) => {
    const trades = [];
    const users = [5,6,7,8]; // Assume these user IDs exist
    const stocks = ["AAPL", "MSFT", "AMZN", "GOOGL"];
    const tradeTypes = ["BUY", "SELL"];

    for (let i = 0; i < numTrades; i++) {
        trades.push({
            userId: users[Math.floor(Math.random() * users.length)],
            symbol: stocks[Math.floor(Math.random() * stocks.length)],
            quantity: Math.floor(Math.random() * 10) + 1,
            action: tradeTypes[Math.floor(Math.random() * tradeTypes.length)]
        });
    }
    return trades;
};

// Single Trade Execution (API)
// const executeSingleTrades = async (trades) => {
//     const start = Date.now();
//     for (const trade of trades) {
//         try {
//             const response = await axios.post(TRADE_API_URL, {
//                 userId: trade.userId,  // Include userId in request
//                 symbol: trade.symbol,
//                 quantity: trade.quantity,
//                 action: trade.action
//             }, {
//                 headers: { Authorization: `Bearer YOUR_TEST_TOKEN_HERE` },
//             });
//             console.log(`✅ Trade Successful: ${trade.symbol} - ${response.data.message}`);
//         } catch (err) {
//             console.error(`❌ Trade Failed: ${trade.symbol} - ${err.response?.data?.error || err.message}`);
//         }
//     }
//     const end = Date.now();
//     console.log(`Single Trade Execution Time (1,000 trades): ${end - start}ms`);
// };



// Batch Trade Execution (API)
const executeBatchTrades = async (trades) => {
    const start = Date.now();
    try {

        await axios.post(`${API_URL}`, { trades }, {
            headers: { Authorization: `Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6OCwiZW1haWwiOiJNYXR0QGdtYWlsLmNvbSIsImlhdCI6MTc0MTEyMzY4NCwiZXhwIjoxNzQxMjEwMDg0fQ.a0dZeEYUSS8_ZWNkZYk-G_uYmvjzHtTq2RuWsyS24XQ` },
        });
    } catch (err) {
        console.error(`Batch Trade Failed: ${err.response?.data?.error || err.message}`);
    }
    const end = Date.now();
    console.log(`Batch Trade Execution Time (1,000 trades): ${end - start}ms`);
};

// Run Benchmark
const runBenchmark = async () => {
    const trades = generateMockTrades(1000);

    // console.log("\n📌 Running Single Trade API Test...");
    // await executeSingleTrades(trades);

    console.log("\n📌 Running Batch Trade API Test...");
    await executeBatchTrades(trades);

    console.log("\n✅ API Benchmark Complete!");
    process.exit();
};

// Execute test
runBenchmark();
