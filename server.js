// server.js

const express = require('express');
const { OpenAI } = require('openai');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static('.')); // Serve static files

const PORT = process.env.PORT || 3000;

// Global variables to store session state
const sessions = new Map();

app.post('/chat', async (req, res) => {
    const { sessionId, models, prompt, tokensPerTurn, reset } = req.body;
    
    console.log('Received request:', { 
        sessionId,
        modelCount: models.length, 
        tokensPerTurn,
        reset,
        promptLength: prompt ? prompt.length : 0,
        hasExistingSession: sessions.has(sessionId)
    });
    
    // If it's a reset request, clear session completely
    if (reset) {
        sessions.delete(sessionId);
        console.log(`Session ${sessionId} reset - all history cleared`);
        return res.json({ success: true, message: 'Session reset successfully' });
    }
    
    // Get or initialize session state
    let session = sessions.get(sessionId);
    if (!session) {
        // Create a completely fresh session
        session = {
            currentTurn: 0,
            fullContent: prompt,
            conversationHistory: [
                { role: "system", content: "Your task is to continue the following piece of writing (you must only output the added content, and must not include this input prompt in the output). Do not repeat any existing text - only add new content to continue." },
                { role: "user", content: prompt }
            ]
        };
        sessions.set(sessionId, session);
        console.log(`New session ${sessionId} created with fresh state`);
    }
    
    // Select current turn's model
    const currentModelIndex = session.currentTurn % models.length;
    const currentModelInfo = models[currentModelIndex];
    const { modelName, apiKey, provider } = currentModelInfo;
    
    console.log(`Turn ${session.currentTurn}, using model: ${modelName} (${provider})`);

    try {
        let response = '';

        // Create a fresh conversation context for this turn
        const currentMessages = [
            { role: "system", content: `Your task is to continue the following piece of writing (you must only output the added content, and must not include this input prompt in the output). The content so far: "${session.fullContent}". Continue this content. Do not repeat any existing text - only add new content to continue.` },
            { role: "user", content: `Continue this from where it left off: ${session.fullContent}` }
        ];

        console.log(`Creating context for turn ${session.currentTurn}: story length = ${session.fullContent.length} chars`);

        switch (provider) {
            case 'openai': {
                const openaiClient = new OpenAI({ apiKey: apiKey });

                const openaiResponse = await openaiClient.chat.completions.create({
                    model: modelName,
                    messages: currentMessages,
                    max_tokens: tokensPerTurn,
                    temperature: 0.7,
                });

                response = openaiResponse.choices[0].message.content;
                break;
            }

            case 'perplexity':
                const perplexityClient = new OpenAI({
                    apiKey: apiKey,
                    baseURL: 'https://api.perplexity.ai'
                });
                
                // Use a different approach for Perplexity to avoid repetition
                const perplexityMessages = [
                    { role: "system", content: "Your task is to continue the following piece of writing (you must only output the added content, and must not include this input prompt in the output). Continue the given content with new content only. Never repeat existing text." },
                    { role: "user", content: `Write ONLY the next part (${tokensPerTurn} tokens max). Do not repeat any existing text.Content so far: "${session.fullContent}"` }
                ];
                
                const perplexityResponse = await perplexityClient.chat.completions.create({
                    model: modelName,
                    messages: perplexityMessages,
                    max_tokens: tokensPerTurn,
                    temperature: 0.7,
                });
                response = perplexityResponse.choices[0].message.content;
                break;

            case 'deepseek':
                const deepseekClient = new OpenAI({
                    apiKey: apiKey,
                    baseURL: 'https://api.deepseek.com'
                });
                const deepseekResponse = await deepseekClient.chat.completions.create({
                    model: modelName,
                    messages: currentMessages,
                    max_tokens: tokensPerTurn,
                    temperature: 0.7,
                });
                response = deepseekResponse.choices[0].message.content;
                break;

            case 'gemini':
                const genAI = new GoogleGenerativeAI(apiKey);
                const model = genAI.getGenerativeModel({ model: modelName });
                
                const geminiPrompt = `Your task is to continue the following piece of writing (you must only output the added content, and must not include this input prompt in the output). Continue this content. Do not repeat any existing text - only add new content: ${session.fullContent}`;
                
                // For very small token counts, we need to be more explicit with Gemini
                const generationConfig = {
                    maxOutputTokens: Math.max(tokensPerTurn, 10), // Gemini has a minimum, so use at least 10
                    temperature: 0.7,
                    stopSequences: ['\n\n'] // Stop at paragraph breaks to limit output
                };
                
                // If tokens per turn is very small, add additional stopping criteria
                if (tokensPerTurn <= 10) {
                    generationConfig.stopSequences.push('.', '!', '?', ',', ';');
                }
                
                const result = await model.generateContent(geminiPrompt, {
                    generationConfig: generationConfig
                });
                
                let geminiResponse = result.response.text();
                
                // If Gemini still generates too much, manually truncate to approximate token count
                if (tokensPerTurn <= 10) {
                    const words = geminiResponse.split(' ');
                    if (words.length > tokensPerTurn * 1.2) { // Allow some flexibility
                        geminiResponse = words.slice(0, Math.max(tokensPerTurn, 3)).join(' ');
                        console.log(`Manually truncated Gemini response to ${tokensPerTurn} tokens`);
                    }
                }
                
                response = geminiResponse;
                break;

            case 'cloudflare':
                // Use server-side Cloudflare credentials configured via environment variables
                const cfApiKey = process.env.CLOUDFLARE_API_KEY;
                const cfAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
                const cfApiBase = process.env.CLOUDFLARE_API_BASE || 'https://api.cloudflare.com/client/v4';

                if (!cfApiKey || !cfAccountId) {
                    throw new Error('Cloudflare API key and account ID must be configured on the server (CLOUDFLARE_API_KEY and CLOUDFLARE_ACCOUNT_ID).');
                }

                // Normalize base URL to avoid duplicate slashes
                const normalizedBase = cfApiBase.replace(/\/$/, '');
                const cloudflareUrl = `${normalizedBase}/accounts/${cfAccountId}/ai/run/${modelName}`;
                
                // Some Cloudflare model backends are strict about ByteString/ASCII-only inputs.
                // To avoid failures, sanitize the context to ASCII before sending.
                const sanitizeToAscii = (text) => text ? text.replace(/[^\x00-\x7F]/g, '?') : '';
                const safeFullContent = sanitizeToAscii(session.fullContent);

                // Build payload depending on model family.
                let cloudflarePayload;
                const isGptOss = modelName.startsWith('@cf/openai/gpt-oss');

                if (isGptOss) {
                    // GPT-OSS models expect `input` or `requests` at the top level, not `messages`.
                    const cloudflarePrompt = [
                        "System: Your task is to continue the following piece of writing. You must only output the added content, and must not include this input prompt in the output. Do not repeat any existing text - only add new content to continue.",
                        `User: Continue this from where it left off (add only new content, max ${tokensPerTurn} tokens): ${safeFullContent}`
                    ].join("\\n\\n");

                    cloudflarePayload = {
                        input: cloudflarePrompt,
                        max_tokens: tokensPerTurn
                    };
                } else {
                    // Llama, Gemma, Mistral etc. work with a messages-style payload.
                    cloudflarePayload = {
                        messages: [
                            {
                                role: "system",
                                content: "Your task is to continue the following piece of writing. You must only output the added content, and must not include this input prompt in the output. Do not repeat any existing text - only add new content to continue."
                            },
                            {
                                role: "user", 
                                content: `Continue this from where it left off (add only new content, max ${tokensPerTurn} tokens): ${safeFullContent}`
                            }
                        ],
                        max_tokens: tokensPerTurn
                    };
                }
                
                const cloudflareResponse = await fetch(cloudflareUrl, {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${cfApiKey}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(cloudflarePayload)
                });
                
                if (!cloudflareResponse.ok) {
                    const errorText = await cloudflareResponse.text();
                    throw new Error(`Cloudflare API error: ${cloudflareResponse.status} - ${errorText}`);
                }
                
                const cloudflareData = await cloudflareResponse.json();
                console.log('Cloudflare response structure:', JSON.stringify(cloudflareData, null, 2));
                
                // Extract response text from Cloudflare's response format
                const resultPayload = cloudflareData.result;
                const stringifyPayload = (payload) => {
                    if (payload == null) return '';
                    return typeof payload === 'string' ? payload : JSON.stringify(payload);
                };

                if (resultPayload && resultPayload.response) {
                    response = resultPayload.response;
                } else if (resultPayload && resultPayload.choices && resultPayload.choices[0]) {
                    response = resultPayload.choices[0].message?.content || resultPayload.choices[0].text;
                } else if (resultPayload && typeof resultPayload === 'string') {
                    response = resultPayload;
                } else if (Array.isArray(resultPayload) && resultPayload.length > 0) {
                    response = stringifyPayload(resultPayload[0]);
                } else if (typeof resultPayload === 'object' && resultPayload !== null) {
                    response = stringifyPayload(resultPayload);
                } else {
                    response = stringifyPayload(cloudflareData);
                }
                break;

            default:
                throw new Error(`Unsupported provider: ${provider}`);
        }
        
        // Normalize response to string for downstream processing
        if (typeof response !== 'string') {
            response = response != null ? String(response) : '';
        }

        // Clean up response to avoid repetition
        // Note: No trimming to preserve the exact LLM output format
        console.log(`Raw response from ${modelName}: "${response}"`);
        
        // Enhanced repetition detection and removal
        // Remove repeated assistant labels that some models prepend.
        response = response.replace(/^(Assistant:\s*)+/i, '');

        if (response.startsWith(session.fullContent)) {
            response = response.substring(session.fullContent.length);
            console.log(`Removed full content prefix, remaining: "${response}"`);
        }
        
        // Check if response starts with any part of the existing content
        const existingWords = session.fullContent.split(' ');
        const responseWords = response.split(' ');
        
        // Find the longest matching suffix-prefix overlap
        let maxOverlap = 0;
        for (let i = 1; i <= Math.min(5, existingWords.length, responseWords.length); i++) {
            const existingSuffix = existingWords.slice(-i).join(' ').toLowerCase();
            const responsePrefix = responseWords.slice(0, i).join(' ').toLowerCase();
            
            if (existingSuffix === responsePrefix) {
                maxOverlap = i;
            }
        }
        
        // If we found overlapping words, remove them from response
        if (maxOverlap > 0) {
            response = responseWords.slice(maxOverlap).join(' ');
            console.log(`Removed ${maxOverlap} overlapping words, remaining: "${response}"`);
        }
        
        // If response is still extremely short after cleanup, just log it
        // but do not replace it with a placeholder marker.
        if (!response || response.trim().length < 2) {
            console.log(`Response too short after cleanup: "${response}"`);
        }
        
        // Update session state
        session.fullContent += ' ' + response;
        session.conversationHistory.push({ 
            role: "assistant", 
            content: response,
            model: modelName,
            turn: session.currentTurn 
        });
        session.currentTurn++;
        sessions.set(sessionId, session);
        
        console.log(`Model ${modelName} generated: "${response}"`);
        console.log(`Session state - Turn: ${session.currentTurn}, Content length: ${session.fullContent.length}`);
        res.json({ 
            reply: response || " ",
            modelName: modelName,
            provider: provider,
            turn: session.currentTurn - 1, // Return the actual turn that was just completed
            sessionTurn: session.currentTurn - 1
        });

    } catch (error) {
        console.error(`Error with ${modelName}:`, error);
        
        // Ensure error messages are also in JSON format
        const errorMessage = error.message || 'Unknown error occurred';
        res.status(500).json({ 
            error: `Error with ${modelName}: ${errorMessage}`,
            modelName: modelName || 'unknown',
            provider: provider || 'unknown'
        });
    }
});

app.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});
