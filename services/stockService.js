import axios from "axios";
import redis from "../redis.js"
import "dotenv/config";
import {pushStockPrices} from "../wsServer.js";
const localStockCache = new Map(); // Local in-memory storage
const STOCK_API_KEY = process.env.STOCK_API_KEY
const STOCKS = [
    "AAPL", "MSFT", "AMZN", "GOOGL", "GOOG", "META", "JNJ", "V", "PG",
    "NVDA", "UNH", "HD", "MA", "DIS", "BAC", "VZ", "ADBE", "CMCSA", "NFLX",
    "PFE", "T", "KO", "NKE", "MRK", "INTC", "CSCO", "XOM", "CVX", "ABT",
    "ORCL", "CRM", "PEP", "IBM", "MCD", "WFC", "QCOM", "UPS", "COST", "MDT",
    "CAT", "HON", "AMGN", "LLY", "PM", "BLK", "GE", "BA", "SBUX", "MMM",
    "F", "GM", "ADP", "SPGI", "RTX", "TMO", "NOW", "BKNG", "MO", "ZTS",
    "COP", "AXP", "SCHW", "CVS", "LOW", "DE", "MET", "PNC", "GS", "CI",
    "TJX", "ICE", "PLD", "DUK", "SO", "ED", "OXY", "FDX", "MMC", "EXC",
    "EQIX", "SLB", "GD", "APD", "NEE", "EOG", "LMT", "USB", "HCA", "BK",
    "ITW", "AEP", "ECL", "PGR", "CSX", "CB", "MS", "TRV", "AON", "VLO"
];

export default async function fetchStockPrices(){
    try{
        const url = `https://financialmodelingprep.com/api/v3/quote/${STOCKS.join(",")}?apikey=${STOCK_API_KEY}`;
        const prices = await axios.get(url)

        if (!prices.data || prices.data.length === 0) throw new error("No stock data received.")
        const multi = redis.multi(); 
        let length = 0
        for (const stock of prices.data) {
            
            if (stock.symbol && stock.price !== undefined){
                multi.hSet("stockPrices", stock.symbol, stock.price);
                length += 1
            }
        }
        await multi.exec();
        pushStockPrices();
        console.log(` Updated ${length} stocks at ${new Date().toLocaleTimeString()}`);

    }
    catch(error){
        return null;
    }
}