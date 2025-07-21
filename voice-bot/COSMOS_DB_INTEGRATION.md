# Cosmos DB Integration Guide

## Overview
Your voice bot is now integrated with Azure Cosmos DB for persistent patient data storage. This provides real-time access to patient information and ensures data consistency across all interactions.

## What's New
- **Real-time Data**: Patient data is fetched directly from Cosmos DB
- **Automatic Updates**: Follow-up calls, medication adherence, and appointments are automatically saved
- **Fallback Support**: Local JSON file fallback for development
- **Secure Authentication**: Uses Azure Managed Identity or connection strings

## Files Added/Modified

### New Files
- `cosmosDbService.js` - Cosmos DB operations service
- `testCosmosIntegration.js` - Test script for Cosmos DB integration
- `.env.example` - Environment variables template

### Modified Files
- `patientBotFactory.js` - Now uses Cosmos DB for patient data
- `bot.js` - Saves conversation data to Cosmos DB
- `index.js` - Updated API endpoints for async operations
- `.env` - Added Cosmos DB configuration
- `.gitignore` - Added security for environment files

## Configuration

### Environment Variables (.env)
```env
# Azure Cosmos DB Configuration
COSMOS_DB_ENDPOINT=https://your-cosmosdb-account.documents.azure.com:443/
COSMOS_DB_CONNECTION_STRING=your-connection-string-here
COSMOS_DB_DATABASE=HealthcareDB
COSMOS_DB_CONTAINER=Patients
```

### Authentication Options
1. **Managed Identity** (Production - Recommended)
   - Leave `COSMOS_DB_CONNECTION_STRING` empty
   - Deploy to Azure with Managed Identity enabled

2. **Connection String** (Development)
   - Set `COSMOS_DB_CONNECTION_STRING` with your connection string
   - Get from Azure Portal > Cosmos DB > Keys

## Testing the Integration

### 1. Test Cosmos DB Connection
```bash
node testCosmosIntegration.js
```

### 2. Import Patient Data (if not done)
```bash
node importData.js
```

### 3. Start the Voice Bot
```bash
npm start
```

## How It Works

### Data Flow
1. **Bot Initialization**: PatientBotFactory loads patient data from Cosmos DB
2. **Patient Lookup**: Bot finds patients by phone number, name, or ID
3. **Conversation Tracking**: Real-time updates to patient records during calls
4. **Data Persistence**: Follow-up status, medication adherence, and appointments saved automatically

### Key Features
- **Patient Lookup**: By phone number, name, or document ID
- **Follow-up Tracking**: Automatic status updates for call completion
- **Medication Adherence**: Saves patient responses about medication compliance
- **Appointment Scheduling**: Updates appointment status in real-time
- **Error Handling**: Robust retry logic and fallback mechanisms

## API Endpoints

### Get All Patients
```
GET /api/patients
```
Returns patient statistics and list of patients needing follow-up calls.

### Get Specific Patient
```
GET /api/patients/:documentId
```
Returns detailed patient information by document ID.

## Troubleshooting

### Common Issues

1. **Connection Errors**
   - Verify `COSMOS_DB_ENDPOINT` and `COSMOS_DB_CONNECTION_STRING`
   - Check network connectivity to Azure

2. **Authentication Errors**
   - For Managed Identity: Ensure it's enabled in Azure
   - For Connection String: Verify it's current and has read/write permissions

3. **Data Not Found**
   - Run `node importData.js` to populate the database
   - Verify database name (`HealthcareDB`) and container name (`Patients`)

4. **Permission Errors**
   - Ensure the connection string has appropriate permissions
   - For Managed Identity: Assign "Cosmos DB Data Contributor" role

### Logs
- Bot operations: Console logs with `[Bot]` prefix
- Factory operations: Console logs with `[Factory]` prefix
- API operations: Console logs with `[API]` prefix

## Security Best Practices

✅ **Implemented**
- Environment variables for sensitive data
- `.gitignore` prevents credential commits
- Managed Identity support for production
- Connection string fallback for development

❗ **Important**
- Never commit `.env` file to source control
- Use Managed Identity in production
- Regularly rotate connection strings
- Monitor access logs in Azure

## Next Steps

1. **Production Deployment**
   - Deploy to Azure App Service or Container Apps
   - Enable Managed Identity
   - Remove connection string from environment

2. **Monitoring**
   - Set up Application Insights
   - Monitor Cosmos DB metrics
   - Add custom logging for conversation analytics

3. **Advanced Features**
   - Add conversation transcripts storage
   - Implement patient notification system
   - Add analytics dashboard
