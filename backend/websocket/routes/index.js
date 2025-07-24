const express = require('express');
const router = express.Router();

// Import WebSocket-related routes
const { router: roomsRouter } = require('./api/rooms');

// Mount WebSocket routes
router.use('/rooms', roomsRouter);

module.exports = router;
