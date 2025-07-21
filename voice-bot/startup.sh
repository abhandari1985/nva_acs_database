#!/bin/bash
# startup.sh - Start both Bot Framework and ACS servers

echo "🚀 Healthcare Voice Bot - Dual Server Startup"
echo "=============================================="

# Check Node.js version
echo "📋 Checking Node.js version..."
node --version

# Check if required environment variables are set
echo ""
echo "🔍 Checking environment variables..."

# Bot Framework variables
if [ -z "$MicrosoftAppId" ]; then
    echo "⚠️  MicrosoftAppId not set (Bot Framework may run in development mode)"
fi

# ACS variables
if [ -z "$ACS_CONNECTION_STRING" ]; then
    echo "❌ ACS_CONNECTION_STRING is required for voice calling"
    echo "   Please configure in .env file"
fi

if [ -z "$SPEECH_KEY" ]; then
    echo "❌ SPEECH_KEY is required for speech services"
    echo "   Please configure in .env file"
fi

# Cosmos DB variables
if [ -z "$COSMOS_DB_ENDPOINT" ]; then
    echo "❌ COSMOS_DB_ENDPOINT is required"
    echo "   Please configure in .env file"
fi

echo ""
echo "🎯 Starting servers..."
echo "📱 Bot Framework (index.js) will run on port 3978"
echo "📞 ACS Voice Server (app.js) will run on port 3979"
echo ""
echo "Press Ctrl+C to stop both servers"
echo ""

# Start both servers concurrently
npm run start:both
