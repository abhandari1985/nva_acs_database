@echo off
REM startup.cmd - Start both Bot Framework and ACS servers (Windows)

echo 🚀 Healthcare Voice Bot - Dual Server Startup
echo ==============================================

REM Check Node.js version
echo 📋 Checking Node.js version...
node --version

echo.
echo 🔍 Checking environment variables...

REM Check ACS variables
if "%ACS_CONNECTION_STRING%"=="" (
    echo ❌ ACS_CONNECTION_STRING is required for voice calling
    echo    Please configure in .env file
)

if "%SPEECH_KEY%"=="" (
    echo ❌ SPEECH_KEY is required for speech services
    echo    Please configure in .env file
)

REM Check Cosmos DB variables
if "%COSMOS_DB_ENDPOINT%"=="" (
    echo ❌ COSMOS_DB_ENDPOINT is required
    echo    Please configure in .env file
)

echo.
echo 🎯 Starting servers...
echo 📱 Bot Framework (index.js) will run on port 3978
echo 📞 ACS Voice Server (app.js) will run on port 3979
echo.
echo Press Ctrl+C to stop both servers
echo.

REM Start both servers concurrently
npm run start:both
