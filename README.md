# Healthcare Voice Agent

A professional AI-powered voice bot for post-discharge patient care, featuring medication adherence support and appointment scheduling capabilities.

## Overview

This healthcare voice agent assists patients with:

- **Medication Adherence**: Follow-up on new prescriptions and dosage protocols
- **Appointment Scheduling**: Book, reschedule, and cancel healthcare appointments
- **Voice Interaction**: Natural speech recognition and synthesis for accessibility
- **Intelligent Routing**: Context-aware agent switching between specialties

## Architecture

- **Node.js Backend**: Express server with Bot Framework integration
- **Azure OpenAI**: GPT-4o-mini for intelligent conversation handling
- **Azure Speech Services**: Professional healthcare voice synthesis
- **Microsoft Graph API**: Real-time calendar integration
- **Multi-Agent System**: Specialized agents for triage, medication, and scheduling

## Prerequisites

### Required Software

- **Node.js** version 18 or higher ([Download](https://nodejs.org))
- **Git** for repository cloning
- **PowerShell** or **Command Prompt** (Windows)

### Azure Resources Required

- **Azure OpenAI Service** with GPT-4o-mini deployment
- **Azure Speech Services** account
- **Microsoft 365** tenant with Graph API permissions
- **Azure App Registration** for Bot Framework

### Verify Node.js Installation

```bash
node --version
npm --version
```

## Getting Started

### 1. Clone the Repository

```bash
git clone https://github.com/abhandari1985/nva_acs_database.git
cd nva_acs_database/voice-bot
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Environment Configuration

Create or update the `.env` file with your Azure credentials:

```properties
# Bot Framework Credentials
MicrosoftAppId="your-bot-app-id"
MicrosoftAppPassword="your-bot-app-password"

# Azure OpenAI Configuration
AZURE_OPENAI_ENDPOINT="https://your-openai-resource.openai.azure.com/"
AZURE_OPENAI_KEY="your-openai-api-key"
AZURE_OPENAI_DEPLOYMENT_NAME="gpt-4o-mini"

# Azure Speech Services
AZURE_SPEECH_KEY="your-speech-service-key"
AZURE_SPEECH_REGION="your-region"

# Microsoft Graph API for Calendar Integration
GRAPH_CLIENT_ID="your-graph-client-id"
GRAPH_TENANT_ID="your-tenant-id"
GRAPH_CLIENT_SECRET="your-graph-client-secret"
GRAPH_USER_ID="target-calendar-user-id"

SCHEDULER_AGENT_EMAIL="scheduler.agent@yourdomain.com"
```

### 4. Start the Application

```bash
npm start
```

The bot will be available at:

- **Main Interface**: <http://localhost:3978>
- **WebChat Interface**: <http://localhost:3978/webchat>
- **API Endpoint**: <http://localhost:3978/api/messages>

## Setup Azure Resources

### Azure OpenAI Service

1. Create an Azure OpenAI resource in your subscription
2. Deploy a `gpt-4o-mini` model
3. Note the endpoint URL and API key

### Azure Speech Services

1. Create a Speech Services resource
2. Note the subscription key and region

### Microsoft Graph API Setup

1. Register an application in Azure AD
2. Grant the following permissions:
   - `Calendars.ReadWrite`
   - `User.Read`
3. Generate a client secret
4. Note the client ID, tenant ID, and secret

### Bot Framework Registration

1. Create a Bot Channels Registration in Azure
2. Configure the messaging endpoint: `https://your-domain.com/api/messages`
3. Note the Microsoft App ID and password

## Usage

### Voice Interface

1. Navigate to <http://localhost:3978>
2. Click "🎤 Start Voice Conversation"
3. Speak naturally with Jenny, the healthcare assistant

### Example Interactions

- **Medication**: "Hi Jenny, I have questions about my new medication"
- **Scheduling**: "I need to schedule an appointment for next week"
- **General**: "Hello, I need help with my post-discharge care"

### API Integration

Send POST requests to `/api/chat`:
```json
{
  "message": "I want to schedule an appointment for tomorrow"
}
```

## Testing

### Health Check

```bash
curl http://localhost:3978/api/test
```

### Chat API Test

```bash
curl -X POST http://localhost:3978/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello Jenny"}'
```

### Bot Framework Emulator

1. Download [Bot Framework Emulator](https://github.com/Microsoft/BotFramework-Emulator/releases)
2. Connect to: `http://localhost:3978/api/messages`

## Current State & Features

### ✅ Implemented Features

- **Multi-Agent Architecture**: Triage routing between medication and scheduling agents
- **Voice Recognition**: Azure Speech Services integration with healthcare-optimized voices
- **Calendar Integration**: Real-time appointment booking via Microsoft Graph API
- **Professional UI**: Clean WebChat interface with voice controls
- **Error Handling**: Comprehensive logging and user-friendly error responses
- **Rate Limiting**: API protection against excessive requests

### 🚧 Production Considerations

- **Security**: Implement proper authentication and authorization
- **Monitoring**: Add Application Insights or similar monitoring
- **Scalability**: Consider Azure Container Apps for production deployment
- **Compliance**: Ensure HIPAA compliance for healthcare data handling

## Project Structure

```text
voice-bot/
├── bot.js                      # Main bot logic and agent orchestration
├── index.js                    # Express server and routing
├── schedulingPlugin.js         # Microsoft Graph calendar integration
├── index.html                  # WebChat interface
├── local-voice-chat.html       # Voice-enabled chat interface
├── package.json                # Dependencies and scripts
├── .env                        # Environment configuration
└── deploymentTemplates/       # Azure deployment templates
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Implement changes with proper testing
4. Submit a pull request with clear description

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Support

For issues and questions:

- Create an issue in the GitHub repository
- Review the Azure documentation links below

## Additional Resources

- [Bot Framework Documentation](https://docs.botframework.com)
- [Azure OpenAI Service](https://docs.microsoft.com/azure/cognitive-services/openai/)
- [Azure Speech Services](https://docs.microsoft.com/azure/cognitive-services/speech-service/)
- [Microsoft Graph API](https://docs.microsoft.com/graph/)
- [Azure Bot Service](https://docs.microsoft.com/azure/bot-service/)
