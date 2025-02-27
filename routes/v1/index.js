const express = require('express');
const router = express.Router();

// Import route files
const authRoutes = require('./auth/login');
const registerRoutes = require('./auth/register')
const tradeRoutes = require('./trading/trade');
const tradeHistoryRoutes = require('./trading/trade_history');
const leaderboardRoutes = require('./analytics/leaderboard');
const holdingsRoutes = require('./analytics/holdings');
const portfolioRoutes = require('./analytics/portfolio')

// Mount the routes (these will now be under "/api")
router.use('/auth', authRoutes);
router.use('/auth', registerRoutes);
router.use('/trading', tradeRoutes);
router.use('/trading', tradeHistoryRoutes);
router.use('/analytics', portfolioRoutes);
router.use('/analytics', leaderboardRoutes);
router.use('/analytics', holdingsRoutes);

module.exports = router;
