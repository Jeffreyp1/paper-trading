import express from "express"
const router = express.Router();
import authRoutes from './auth/login.js';
import registerRoutes from './auth/register.js';
import tradeRoutes from './trading/trade.js';
import newTradeRoutes from './trading/new_trade.js';
import tradeHistoryRoutes from './trading/trade_history.js';
import leaderboardRoutes from './analytics/leaderboard.js';
import holdingsRoutes from './analytics/holdings.js';
import portfolioRoutes from './analytics/portfolio.js';




router.use('/auth', authRoutes);
router.use('/auth', registerRoutes);
// router.use('/trading', newTradeRoutes);
router.use('/trading', tradeRoutes);
router.use('/trading', tradeHistoryRoutes);
router.use('/analytics', leaderboardRoutes);
router.use('/analytics', holdingsRoutes);
router.use('/analytics', portfolioRoutes);


export default router