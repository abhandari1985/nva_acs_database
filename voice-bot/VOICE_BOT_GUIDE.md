# Healthcare Voice Bot - Complete Guide

## 🎯 Project Overview

A comprehensive healthcare voice bot system that combines Azure Communication Services for phone calls with Bot Framework for text conversations. The system provides automated patient outreach, medication reminders, and health check-ins through both voice calls and text chat.

## 🏗️ Architecture

```
📱 Text Conversations          📞 Voice Phone Calls
     ↓                              ↓
┌─────────────────┐          ┌─────────────────┐
│   index.js      │          │     app.js      │
│ (Port 3978)     │          │ (Port 3979)     │
│ Bot Framework   │          │ Call Automation │
└─────────────────┘          └─────────────────┘
     ↓                              ↓
┌─────────────────┐          ┌─────────────────┐
│     bot.js      │          │ Speech Services │
│ Teams/Web Chat  │          │   + Phone API   │
└─────────────────┘          └─────────────────┘
             ↓                      ↓
         ┌─────────────────────────────────┐
         │      Shared Services            │
         │ • cosmosDbService.js            │
         │ • patientBotFactory.js          │
         │ • Patient Database              │
         └─────────────────────────────────┘
```

## 🚀 Quick Start

### Prerequisites
- Node.js 18.x or higher
- Azure subscription with:
  - Azure Communication Services
  - Azure Cosmos DB
  - Azure Speech Services
  - Microsoft Dev Tunnel (for development)

### Installation

1. **Clone and install dependencies:**
   ```bash
   git clone <repository-url>
   cd voice-bot
   npm install
   ```

2. **Configure environment variables:**
   ```bash
   cp .env.example .env
   # Edit .env with your Azure service credentials
   ```

3. **Start the services:**
   ```bash
   # Text bot server (port 3978)
   npm run start

   # Voice calling server (port 3979)
   npm run start:voice

   # Both servers (development)
   npm run start:both
   ```

### Testing Voice Calls

1. **Test international calling:**
   ```bash
   node testAcsCall.js
   ```

2. **View patients available for calling:**
   ```bash
   node showPatientsForCalling.js
   ```

## 📞 Voice Calling Features

### Key Capabilities
- **International Calling**: US to India (+18667759336 → +919158066045)
- **Real-time Speech**: Azure Speech Services for TTS and STT
- **Patient Context**: Personalized conversations with patient data
- **Call State Management**: Automatic cleanup and memory management
- **Event Handling**: Complete ACS webhook integration

### Call Flow
1. **Outbound Call**: System calls patient phone number
2. **Greeting**: Personalized greeting with patient name and doctor
3. **Health Check**: Questions about medications and symptoms
4. **Data Collection**: Responses saved to Cosmos DB
5. **Call Summary**: Automatic documentation

### Supported Scenarios
- **Medication Reminders**: Daily/weekly medication adherence calls
- **Follow-up Appointments**: Post-visit health check-ins
- **Symptom Monitoring**: Regular health status updates
- **Emergency Alerts**: Critical health notifications

## 💾 Data Integration

### Cosmos DB Setup
The system uses Azure Cosmos DB for persistent patient data storage:

```javascript
// Environment Configuration
COSMOS_DB_ENDPOINT=https://your-cosmos-account.documents.azure.com:443/
COSMOS_DB_CONNECTION_STRING=AccountEndpoint=https://...
COSMOS_DB_DATABASE=HealthcareDB
COSMOS_DB_CONTAINER=Patients
```

### Patient Data Structure
```json
{
  "id": "patient_001",
  "DocumentID": "PATIENT",
  "patientName": "John Doe",
  "phoneNumber": "+919158066045",
  "doctorName": "Dr. Smith",
  "medications": [
    {
      "medicationName": "Metformin",
      "dosage": "500mg",
      "frequency": "Twice daily",
      "lastTaken": "2024-01-15"
    }
  ],
  "lastCallDate": "2024-01-15T10:30:00Z",
  "callHistory": [],
  "preferences": {
    "preferredCallTime": "morning",
    "language": "en-IN"
  }
}
```

## 🔧 Configuration

### Environment Variables (.env)

```env
# Azure Communication Services
ACS_CONNECTION_STRING=endpoint=https://...
ACS_PHONE_NUMBER=+18667759336
ACS_CALLBACK_URL=https://your-devtunnel.inc1.devtunnels.ms

# Azure Speech Services  
SPEECH_KEY=your-speech-key
SPEECH_REGION=eastus

# Azure Cosmos DB
COSMOS_DB_ENDPOINT=https://your-cosmos-account.documents.azure.com:443/
COSMOS_DB_CONNECTION_STRING=AccountEndpoint=https://...
COSMOS_DB_DATABASE=HealthcareDB
COSMOS_DB_CONTAINER=Patients

# Bot Framework (for text conversations)
MicrosoftAppType=MultiTenant
MicrosoftAppId=your-app-id
MicrosoftAppPassword=your-app-password
MicrosoftAppTenantId=your-tenant-id
```

### Dev Tunnel Setup (Development)

1. **Install Microsoft Dev Tunnel:**
   ```bash
   devtunnel --help
   ```

2. **Create and start tunnel:**
   ```bash
   devtunnel create --allow-anonymous
   devtunnel port create -p 3979
   devtunnel host
   ```

3. **Update ACS_CALLBACK_URL** in `.env` with your tunnel URL

## 🧪 Testing & Development

### Available Test Scripts

| Script | Purpose |
|--------|---------|
| `testAcsCall.js` | Test international voice calling |
| `showPatientsForCalling.js` | List patients ready for calls |
| `setupTestPatients.js` | Initialize test patient data |

### Development Workflow

1. **Start both servers:**
   ```bash
   npm run start:both
   ```

2. **Test voice calling:**
   ```bash
   node testAcsCall.js
   ```

3. **Monitor logs** for ACS events and patient interactions

4. **Check Cosmos DB** for saved conversation data

## 🌍 International Calling

### Current Setup
- **Source Number**: +18667759336 (US ACS Number)
- **Target Number**: +919158066045 (India)
- **Calling Direction**: US → India
- **Speech Language**: English (India) for better recognition

### Phone Number Format
- Must include country code: `+919158066045`
- International calling rates apply
- Azure Communication Services handles routing

### Call Quality Optimization
- **Speech Recognition**: Optimized for Indian English (`en-IN`)
- **Network Quality**: Real-time monitoring and fallback
- **Audio Settings**: Enhanced for international calls
- **Error Recovery**: Automatic retry with exponential backoff

## 🔐 Security & Best Practices

### Authentication
- **Managed Identity**: Preferred for Azure services
- **Connection Strings**: Fallback for development
- **Environment Variables**: Secure credential storage
- **No Hardcoded Secrets**: All sensitive data in `.env`

### Error Handling
- **Graceful Degradation**: Fallback to local data if Cosmos DB unavailable
- **Retry Logic**: Automatic retry for transient failures
- **Call Cleanup**: Automatic state management and memory cleanup
- **Comprehensive Logging**: Detailed error tracking and debugging

### Performance
- **Call State Management**: Efficient memory usage with automatic cleanup
- **Connection Pooling**: Optimized Azure service connections
- **Async Operations**: Non-blocking patient data operations
- **Timeout Handling**: Configurable timeouts for all operations

## 📚 API Reference

### Voice Calling Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/trigger-call` | POST | Initiate outbound call to patient |
| `/api/callbacks` | POST | ACS webhook for call events |
| `/api/health` | GET | Health check for voice services |
| `/api/patients` | GET | List patients available for calling |

### Request/Response Examples

**Trigger Call:**
```json
POST /api/trigger-call
{
  "phoneNumber": "+919158066045",
  "patientName": "John Doe",
  "doctorName": "Dr. Smith",
  "medications": [{"medicationName": "Metformin", "dosage": "500mg"}]
}
```

**Response:**
```json
{
  "success": true,
  "callConnectionId": "call-123-456",
  "message": "Call initiated successfully",
  "phoneNumber": "+919158066045",
  "patient": "John Doe"
}
```

## 🚀 Deployment

### Azure Resources Required
- **Azure Communication Services**: Phone number and calling capabilities
- **Azure Cosmos DB**: Patient data storage
- **Azure Speech Services**: Text-to-speech and speech-to-text
- **Azure App Service**: Web application hosting
- **Azure Application Insights**: Monitoring and analytics

### Production Deployment
1. **Create Azure resources** using the provided Bicep templates
2. **Configure environment variables** in Azure App Service
3. **Deploy application** using Azure DevOps or GitHub Actions
4. **Configure webhooks** for ACS callback URLs
5. **Test end-to-end** voice calling functionality

## 🤝 Contributing

1. **Fork the repository**
2. **Create feature branch** (`git checkout -b feature/amazing-feature`)
3. **Commit changes** (`git commit -m 'Add amazing feature'`)
4. **Push to branch** (`git push origin feature/amazing-feature`)
5. **Open Pull Request**

## 📞 Support

For questions or issues:
- **Create GitHub Issue** for bugs or feature requests
- **Check documentation** in this README
- **Review test scripts** for usage examples
- **Monitor Azure logs** for troubleshooting

---

**Built with ❤️ using Azure Communication Services, Bot Framework, and Azure Cosmos DB**
