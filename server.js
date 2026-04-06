import express from 'express';
import fs from 'fs';
import path from 'path';
import SwaggerParser from '@apidevtools/swagger-parser';
import axios from 'axios';
import dotenv from 'dotenv';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import OpenAI from 'openai';

dotenv.config();

// ===== AZURE OPENAI CONFIG =====
const endpoint = 'https://puni-ai-3dx.openai.azure.com/openai/v1/';
//const deploymentName = 'DeepSeek-V3.2';
const deploymentName = 'gpt-4.1';
const apiKey ='4PjjXy4WEaH75W25ygxgXrCallg9i639I9nImaW8e6SN1P7Rq1MgJQQJ99CCACYeBjFXJ3w3AAABACOGVe3O';
const client = new OpenAI({
    baseURL: endpoint,
    apiKey: apiKey,
});

// ===== EXPRESS APP =====
const app = express();
app.use(express.json({ limit: '10mb' }));

app.use(
    cors({
        origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://localhost:*'],
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    })
);

// ===== GLOBAL REGISTRY =====
const SPECS_DIR = './specs';
const apiRegistry = {};
let executeApiHandler = null;

// ===== RATE LIMITING =====
const chatLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 1000,
    message: { error: 'Too many requests from this IP', timestamp: new Date().toISOString() },
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.ip === '::1' || req.ip === '127.0.0.1' || req.path === '/health',
});

const mcpLimiter = rateLimit({
    windowMs: 1 * 60 * 1000,
    max: 50,
    message: { error: 'MCP rate limit exceeded' },
});

// ===== UTILITY FUNCTIONS =====
function sanitizeName(name) {
    return name
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/^[._]+|[._]+$/g, '')
        .slice(0, 128);
}

function getToolDetail(toolName) {
    if (!toolName) return null;
    for (const [prefix, spec] of Object.entries(apiRegistry)) {
        for (const [urlPath, methods] of Object.entries(spec.paths || {})) {
            for (const [method, detail] of Object.entries(methods)) {
                if (typeof detail !== 'object') continue;
                const operationId =
                    detail.operationId || `${method}${urlPath.replace(/\//g, '_')}`;
                const fullToolName = sanitizeName(`${prefix}_${operationId}`);
                if (fullToolName === toolName) {
                    return { prefix, spec, method, path: urlPath, detail };
                }
            }
        }
    }
    return null;
}


function buildToolSchema(detail) {
    const paramsSchema = (detail.parameters || [])
        .filter((p) => p.in === 'query' || p.in === 'path')
        .reduce((acc, p) => {
            acc[p.name] = p.schema || { type: 'string' };
            return acc;
        }, {});

    const bodySchema =
        detail.requestBody?.content?.['application/json']?.schema || {
            type: 'object',
            additionalProperties: true,
        };

    return {
        type: 'object',
        properties: {
            params: {
                type: 'object',
                properties: paramsSchema,
                additionalProperties: true,
            },
            body: bodySchema,
        },
        required: [],
    };
}

// ===== SPEC LOADING =====
async function loadSpecs() {
    if (!fs.existsSync(SPECS_DIR)) {
        fs.mkdirSync(SPECS_DIR, { recursive: true });
        console.log(`📁 Created ${SPECS_DIR}`);
        return 0;
    }

    const files = fs.readdirSync(SPECS_DIR);
    let loaded = 0;

    for (const file of files) {
        if (file.match(/\.(json|yaml|yml|openapi)$/i)) {
            const filePath = path.join(SPECS_DIR, file);
            const prefix = path.parse(file).name;

            try {
                apiRegistry[prefix] = await SwaggerParser.dereference(filePath);
                console.log(`✅ Loaded ${prefix}`);
                loaded++;
            } catch (e) {
                console.error(`❌ Failed ${file}: ${e.message}`);
            }
        }
    }

    console.log(`📊 Total APIs loaded: ${loaded}`);
    return loaded;
}

// ===== ENHANCED TOOL DISCOVERY =====
function getAllTools() {
    if (global.toolCache && Object.keys(global.toolCache).length > 0) {
        return global.toolCache;
    }

    const tools = {};
    Object.entries(apiRegistry).forEach(([prefix, spec]) => {
        const baseUrl = spec.servers?.[0]?.url || '';
        for (const [urlPath, methods] of Object.entries(spec.paths || {})) {
            for (const [method, detail] of Object.entries(methods)) {
                if (typeof detail !== 'object') continue;

                const operationId =
                    detail.operationId || `${method}${urlPath.replace(/\//g, '_')}`;
                const toolName = sanitizeName(`${prefix}_${operationId}`);

                tools[toolName] = {
                    name: toolName,
                    description:
                        detail.summary ||
                        detail.description ||
                        `${method.toUpperCase()} ${urlPath}`,
                    method: method.toUpperCase(),
                    path: urlPath,
                    baseUrl,
                    api: prefix,
                    detail,
                };
            }
        }
    });

    global.toolCache = tools;
    return tools;
}


// ===== MCP SERVER =====
const mcpServer = new McpServer({
    name: '3DX-Executor',
    version: '1.0.0',
});

async function registerExecutorTools() {
    // ===== 1. CORE EXECUTOR TOOL =====
    const apiHandler = async ({ action, params = {}, body = {}, headers = {} }) => {
        const startTime = Date.now();

        try {
            const tool = (global.toolCache || getAllTools())[action];
            if (!tool) {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `❌ Tool "${action}" not found.\n💡 Run: list_tools page=1 limit=10`,
                        },
                    ],
                    isError: true,
                };
            }

            // 1. mandatory headers (non-auth)
            const requiredHeaders = tool.detail.parameters
                ?.filter((p) => p.in === 'header' && p.required && !p.name.toLowerCase().includes('auth'))
                ?.map((p) => p.name) || [];

            const missingHeaders = requiredHeaders.filter((h) => !headers[h]);
            if (missingHeaders.length > 0) {
                return {
                    content: [
                        {
                            type: 'text',
                            text:
                                `❌ **MISSING HEADERS**:\n` +
                                `${missingHeaders.map((h) => `• ${h}`).join('\n')}\n\n` +
                                `💡 Use: headers: {"${missingHeaders[0]}": "value"}`,
                        },
                    ],
                    isError: true,
                };
            }

            // 2. mask sensitive fields
            const maskedFields = tool.detail['x-masked'] || [
                'password',
                'secret',
                'token',
                'key',
                'private',
                'credential',
            ];

            const safeBody = JSON.parse(JSON.stringify(body));
            maskedFields.forEach((field) => {
                if (safeBody[field] !== undefined) safeBody[field] = '[MASKED]';
            });

            // 3. build final URL, separating path and query
            let finalUrl = tool.baseUrl + tool.path;
            const query = { ...params };

            for (const [key, value] of Object.entries(params || {})) {
                const token = `{${key}}`;
                if (finalUrl.includes(token)) {
                    finalUrl = finalUrl.replace(token, encodeURIComponent(value));
                    delete query[key]; // do NOT also send as query param
                }
            }

            // 4. execute with redirection
            console.log(`🔧 [${Date.now() - startTime}ms] ${tool.method.toUpperCase()} ${finalUrl}`);

            const response = await axios({
                method: tool.method,
                url: finalUrl,
                params: query,
                data: body,
                headers: {
                    'Content-Type': 'application/json',
                    ...headers,
                },
                timeout: 15000,
                maxRedirects: 5,
                validateStatus: () => true,
                followRedirect: true,
            });

            // 5. mask response sensitive data
            const safeData = JSON.parse(JSON.stringify(response.data));
            maskedFields.forEach((field) => {
                if (safeData[field] !== undefined) safeData[field] = '[MASKED]';
            });

            const executionTime = Date.now() - startTime;

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                success: response.status >= 200 && response.status < 300,
                                status: response.status,
                                statusText: response.statusText,
                                executionTime: `${executionTime}ms`,
                                url: finalUrl,
                                data: safeData,
                                headers: Object.fromEntries(
                                    Object.entries(response.headers).filter(
                                        ([key]) => !maskedFields.some((m) => key.toLowerCase().includes(m))
                                    )
                                ),
                                tool: action,
                                missing_headers: missingHeaders,
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        } catch (error) {
            console.error(`❌ [${Date.now() - startTime}ms] ${error.message}`);
            return {
                content: [
                    {
                        type: 'text',
                        text: `❌ **ERROR**: ${error.message}\n\n💡 Missing headers? Run: list_tools "${action}"`,
                    },
                ],
                isError: true,
            };
        }
    };

    // ===== 2. PAGINATED TOOL DISCOVERY =====
    mcpServer.tool(
        'list_tools',
        {
            page: { type: 'number', default: 1 },
            limit: { type: 'number', default: 20 },
            filter: { type: 'string', description: 'Filter by prefix or keyword' },
        },
        async ({ page = 1, limit = 20, filter = '' }) => {
            const allTools = Object.entries(global.toolCache || getAllTools())
                .filter(([name]) => !filter || name.includes(filter))
                .map(([name, info]) => ({
                    name,
                    description: info?.description || name,
                    method: info?.method?.toUpperCase() || 'UNKNOWN',
                    api: info?.api || 'unknown',
                }));

            const start = (page - 1) * limit;
            const paginated = allTools.slice(start, start + limit);

            return {
                content: [
                    {
                        type: 'text',
                        text: JSON.stringify(
                            {
                                total: allTools.length,
                                page,
                                limit,
                                totalPages: Math.ceil(allTools.length / limit),
                                tools: paginated,
                                filters: Object.keys(apiRegistry),
                                example: `execute_api action="dseng_v1_POST_/engineeringItems" body={"title":"test"}`,
                            },
                            null,
                            2
                        ),
                    },
                ],
            };
        }
    );

    // ===== 3. MAIN EXECUTOR TOOL =====
    mcpServer.tool(
        'execute_api',
        {
            action: {
                type: 'string',
                description: 'Exact tool name from "list_tools"',
            },
            params: { type: 'object', description: 'Path/query parameters' },
            body: { type: 'object', description: 'Request body (POST/PUT)' },
            headers: {
                type: 'object',
                description: 'Non-auth HTTP headers (Content-Type, X-Requested-With)',
            },
        },
        apiHandler
    );

    // ===== 4. HELPER TOOLS =====
    mcpServer.tool('health', {}, () => ({
        content: [
            {
                type: 'text',
                text: `✅ 3DX-Executor Healthy\nTools: ${
                    Object.keys(global.toolCache || {}).length
                }\nAPIs: ${Object.keys(apiRegistry).length}`,
            },
        ],
    }));

    executeApiHandler = apiHandler;
    console.log('✅ MCP tools registered: execute_api, list_tools, health');
}

// ===== HELPER: Get multiple matching tools =====
async function getMultipleToolSuggestions(message, availableTools, limit = 5) {
    try {
        const analysis = await client.chat.completions.create({
            model: deploymentName,
            messages: [
                {
                    role: 'user',
                    content: `You are a tool matcher. Find ALL potentially relevant tools for the user request.

Available tool names (one per line):
${availableTools.join('\n')}

User request: "${message}"

Rules:
1. List ONLY the tool names, one per line.
2. Order by relevance (most relevant first).
3. Maximum ${limit} tools.
4. If NO tools are relevant, respond with: NONE
5. Do NOT add explanations, quotes, or extra text.

Answer with ONLY tool names or NONE:`,
                },
            ],
            max_tokens: 200,
            temperature: 0,
        });

        const content = analysis.choices[0].message.content.trim();
        if (content === 'NONE') return [];

        return content
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line && line !== 'NONE')
            .slice(0, limit);
    } catch (e) {
        console.error('Error getting multiple suggestions:', e.message);
        return [];
    }
}

// ===== ENHANCED CHAT ENDPOINT (HARDENED) =====
app.post('/chat', chatLimiter, async (req, res) => {
    try {
        const { message, conversation = [], selectedTool = null } = req.body;
        console.log(`🔄 Chat: "${message?.substring(0, 50)}..."`);

        // ===== CASE 1: User is selecting from suggestions =====
        if (selectedTool) {
            console.log(`✓ User selected tool: ${selectedTool}`);
            const toolDetail = getToolDetail(selectedTool);

            if (!toolDetail) {
                return res.status(400).json({
                    mode: 'error',
                    reason: `Selected tool "${selectedTool}" not found.`,
                });
            }

            // Re-run extraction and execution for the selected tool
            const schema = buildToolSchema(toolDetail.detail);
            const paramsSchema = schema.properties?.params?.properties || {};
            const bodySchema = schema.properties?.body || {};

            const raw = toolDetail.detail;
            const requiredParams = (raw.parameters || [])
                .filter((p) => (p.in === 'path' || p.in === 'query') && p.required)
                .map((p) => p.name);

            const requiredBody = Array.isArray(
                raw.requestBody?.content?.['application/json']?.schema?.required
            )
                ? raw.requestBody.content['application/json'].schema.required
                : [];

            // Extract params/body from message for the selected tool
            const extractionPrompt = `You are a strict JSON extractor.

Tool: "${selectedTool}"
HTTP method: ${toolDetail.method.toUpperCase()}
Path: ${toolDetail.path}

Params schema (query+path):
${JSON.stringify(paramsSchema, null, 2)}

Body schema:
${JSON.stringify(bodySchema, null, 2)}

REQUIRED params: ${JSON.stringify(requiredParams)}
REQUIRED body fields: ${JSON.stringify(requiredBody)}

User: "${message}"

Respond with ONLY valid JSON, no markdown, no comments:

{
  "params": {},
  "body": {},
  "missing": {
    "params": [],
    "body": []
  },
  "suggested": {
    "params": [],
    "body": []
  }
}`;

            const extraction = await client.chat.completions.create({
                model: deploymentName,
                messages: [{ role: 'user', content: extractionPrompt }],
                max_tokens: 400,
                temperature: 0,
            });

            let extracted;
            try {
                extracted = JSON.parse(extraction.choices[0].message.content);
            } catch (e) {
                extracted = {
                    params: {},
                    body: {},
                    missing: { params: requiredParams, body: requiredBody },
                    suggested: { params: [], body: [] },
                };
            }

            const { params = {}, body = {}, missing = {}, suggested = {} } = extracted;

            const missingParams = Array.isArray(missing.params)
                ? missing.params
                : requiredParams.filter((n) => params[n] == null);
            const missingBody = Array.isArray(missing.body)
                ? missing.body
                : requiredBody.filter((n) => body[n] == null);

            const requiredHeadersDetails =
                raw.parameters?.filter(
                    (p) => p.in === 'header' && p.required && !p.name.toLowerCase().includes('auth')
                ) || [];

            const requiredHeaders = requiredHeadersDetails.map((h) => h.name);
            const headerSuggestions = requiredHeadersDetails.map((h) => ({
                name: h.name,
                description: h.description || '',
            }));

            const baseUrl = toolDetail.spec.servers?.[0]?.url || '';
            const pathTemplate = toolDetail.path;

            const pathParams = Object.fromEntries(
                Object.entries(params).filter(([k]) => pathTemplate.includes(`{${k}}`))
            );

            const queryParams = Object.fromEntries(
                Object.entries(params).filter(([k]) => !pathTemplate.includes(`{${k}}`))
            );

            const endpointDescriptor = {
                action: selectedTool,
                method: toolDetail.method.toUpperCase(),
                baseUrl,
                pathTemplate,
                pathParams,
                queryParams,
                headers: {},
                body,
                required: {
                    params: requiredParams,
                    body: requiredBody,
                    headers: requiredHeaders,
                },
                missing: {
                    params: missingParams,
                    body: missingBody,
                    headers: missingHeaders,
                },
                suggestions: {
                    params: Array.isArray(suggested.params) ? suggested.params : [],
                    body: Array.isArray(suggested.body) ? suggested.body : [],
                    headers: headerSuggestions,
                },
                redirect: {
                    enabled: true,
                    maxRedirects: 5,
                },
            };

            const readyToExecute =
                endpointDescriptor.missing.params.length === 0 &&
                endpointDescriptor.missing.body.length === 0 &&
                endpointDescriptor.missing.headers.length === 0;

            endpointDescriptor.readyToExecute = readyToExecute;

            // If ready, execute immediately
            if (readyToExecute) {
                const execResult = await executeApiHandler({
                    action: selectedTool,
                    params: { ...pathParams, ...queryParams },
                    body,
                    headers: endpointDescriptor.headers,
                });

                let parsedResult;
                try {
                    parsedResult = JSON.parse(execResult.content[0].text);
                } catch {
                    parsedResult = { raw: execResult.content[0].text };
                }

                return res.json({
                    mode: 'execute',
                    endpoint: endpointDescriptor,
                    rawResult: parsedResult,
                });
            } else {
                return res.json({
                    mode: 'analyze',
                    endpoint: endpointDescriptor,
                });
            }
        }

        // ===== CASE 2: Initial tool identification =====
        const availableTools = Object.keys(getAllTools());
        const analysis = await client.chat.completions.create({
            model: deploymentName,
            messages: [
                {
                    role: 'user',
                    content: `You are a strict tool selector.

Available tool names (one per line):
${availableTools.join('\n')}

User request: "${message}"

Rules:
1. You MUST answer with EXACTLY ONE of the tool names above if any tool is appropriate.
2. Do NOT add quotes, spaces, explanations, JSON, markdown, or extra text.
3. If NO tool is appropriate, reply with exactly: NONE

Answer with ONLY the tool name or NONE.`,
                },
            ],
            max_tokens: 50,
            temperature: 0,
        });

        let toolNameRaw = analysis.choices[0].message.content.trim();
        toolNameRaw = toolNameRaw.replace(/^"+|"+$/g, ''); // strip quotes if model adds them
        const toolName = toolNameRaw.split(/\s+/)[0];      // take first token only

        if (toolName === 'NONE') {
            // Get multiple suggestions when model is confused
            const suggestions = await getMultipleToolSuggestions(message, availableTools, 5);
            return res.json({
                mode: 'suggest',
                reason: `Model reported no suitable tool for "${message}". Here are possible alternatives:`,
                suggestions: suggestions.length > 0 ? suggestions : availableTools.slice(0, 5),
                nextAction: `Send: {"message": "${message}", "selectedTool": "tool_name_here"}`,
            });
        }

        const toolDetail = getToolDetail(toolName);

        if (!toolDetail) {
            // Get multiple suggestions when tool not found
            const suggestions = await getMultipleToolSuggestions(message, availableTools, 5);
            return res.json({
                mode: 'suggest',
                reason: `No matching tool for "${message}". Model suggested "${toolNameRaw}" which wasn't found. Here are alternatives:`,
                suggestions: suggestions.length > 0 ? suggestions : availableTools.slice(0, 5),
                nextAction: `Send: {"message": "${message}", "selectedTool": "tool_name_here"}`,
            });
        }


        // Step 2: Analyze schema
        const schema = buildToolSchema(toolDetail.detail);
        const paramsSchema = schema.properties?.params?.properties || {};
        const bodySchema = schema.properties?.body || {};

        const raw = toolDetail.detail;
        const requiredParams = (raw.parameters || [])
            .filter((p) => (p.in === 'path' || p.in === 'query') && p.required)
            .map((p) => p.name);

        const requiredBody = Array.isArray(
            raw.requestBody?.content?.['application/json']?.schema?.required
        )
            ? raw.requestBody.content['application/json'].schema.required
            : [];

        // Step 3: Extract user params/body
        const extractionPrompt = `You are a strict JSON extractor.

Tool: "${toolName}"
HTTP method: ${toolDetail.method.toUpperCase()}
Path: ${toolDetail.path}

Params schema (query+path):
${JSON.stringify(paramsSchema, null, 2)}

Body schema:
${JSON.stringify(bodySchema, null, 2)}

REQUIRED params: ${JSON.stringify(requiredParams)}
REQUIRED body fields: ${JSON.stringify(requiredBody)}

User: "${message}"

Respond with ONLY valid JSON, no markdown, no comments:

{
  "params": {},
  "body": {},
  "missing": {
    "params": [],
    "body": []
  },
  "suggested": {
    "params": [],
    "body": []
  }
}`;

        const extraction = await client.chat.completions.create({
            model: deploymentName,
            messages: [{ role: 'user', content: extractionPrompt }],
            max_tokens: 400,
            temperature: 0,
        });

        let extracted;
        try {
            extracted = JSON.parse(extraction.choices[0].message.content);
        } catch (e) {
            // fallback: empty but safe
            extracted = {
                params: {},
                body: {},
                missing: { params: requiredParams, body: requiredBody },
                suggested: { params: [], body: [] },
            };
        }

        const { params = {}, body = {}, missing = {}, suggested = {} } = extracted;

        const missingParams = Array.isArray(missing.params)
            ? missing.params
            : requiredParams.filter((n) => params[n] == null);
        const missingBody = Array.isArray(missing.body)
            ? missing.body
            : requiredBody.filter((n) => body[n] == null);

        // Step 4: required headers
        const requiredHeadersDetails =
            raw.parameters?.filter(
                (p) => p.in === 'header' && p.required && !p.name.toLowerCase().includes('auth')
            ) || [];

        const requiredHeaders = requiredHeadersDetails.map((h) => h.name);
        const missingHeaders = requiredHeaders; // by design, client must fill them

        const headerSuggestions = requiredHeadersDetails.map((h) => ({
            name: h.name,
            description: h.description || '',
        }));

        // Step 5: build endpoint descriptor
        const baseUrl = toolDetail.spec.servers?.[0]?.url || '';
        const pathTemplate = toolDetail.path;

        const pathParams = Object.fromEntries(
            Object.entries(params).filter(([k]) => pathTemplate.includes(`{${k}}`))
        );

        const queryParams = Object.fromEntries(
            Object.entries(params).filter(([k]) => !pathTemplate.includes(`{${k}}`))
        );

        const endpointDescriptor = {
            action: toolName,
            method: toolDetail.method.toUpperCase(),
            baseUrl,
            pathTemplate,
            pathParams,
            queryParams,
            headers: {}, // client will fill auth + required non-auth headers
            body,
            required: {
                params: requiredParams,
                body: requiredBody,
                headers: requiredHeaders,
            },
            missing: {
                params: missingParams,
                body: missingBody,
                headers: missingHeaders,
            },
            suggestions: {
                params: Array.isArray(suggested.params) ? suggested.params : [],
                body: Array.isArray(suggested.body) ? suggested.body : [],
                headers: headerSuggestions,
            },
            redirect: {
                enabled: true,
                maxRedirects: 5,
            },
        };

        const readyToExecute =
            endpointDescriptor.missing.params.length === 0 &&
            endpointDescriptor.missing.body.length === 0 &&
            endpointDescriptor.missing.headers.length === 0;

        endpointDescriptor.readyToExecute = readyToExecute;

        // If not ready, just return analysis JSON
        if (!readyToExecute) {
            return res.json({
                mode: 'analyze',
                endpoint: endpointDescriptor,
            });
        }

        // Step 6: EXECUTE if all good (server-side) using MCP executor logic
        const execResult = await executeApiHandler({
            action: toolName,
            params: { ...pathParams, ...queryParams },
            body,
            headers: endpointDescriptor.headers,
        });

        let parsedResult;
        try {
            parsedResult = JSON.parse(execResult.content[0].text);
        } catch {
            parsedResult = { raw: execResult.content[0].text };
        }

        return res.json({
            mode: 'execute',
            endpoint: endpointDescriptor,
            rawResult: parsedResult,
        });
    } catch (error) {
        console.error('Chat error:', error.message);
        res.status(500).json({
            mode: 'error',
            error: error.message,
        });
    }
});

// ===== MCP ENDPOINT (STRUCTURED) =====
app.all('/mcp', mcpLimiter, async (req, res) => {
    try {
        const { message, conversation = [], headers = {}, direct = false } =
            req.method === 'GET' ? req.query : req.body;

        if (!message && !direct) {
            return res.status(400).json({
                mode: 'error',
                error: "Missing 'message' for MCP-style discovery",
            });
        }

        // If caller wants to drive MCP protocol directly, keep old behaviour
        if (direct) {
            const transport = new StreamableHTTPServerTransport(req, res);
            await mcpServer.connect(transport);
            return;
        }

        // Reuse same logic as /chat to produce endpoint descriptor
        const analysisResp = await axios.post(
            `${req.protocol}://${req.get('host')}/chat`,
            { message, conversation },
            { headers: { 'Content-Type': 'application/json' } }
        );

        const { mode, endpoint, rawResult } = analysisResp.data;

        return res.json({
            mode,
            endpoint: endpoint || null,
            result: rawResult || null,
        });
    } catch (error) {
        console.error('MCP error:', error);
        res.status(500).json({
            mode: 'error',
            error: error.message || 'MCP server error',
        });
    }
});

// ===== HEALTH AND TOOLS ENDPOINTS =====
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        version: '1.0.0',
        apisLoaded: Object.keys(apiRegistry).length,
        totalTools: Object.keys(getAllTools()).length,
        azureDeployment: deploymentName,
        timestamp: new Date().toISOString(),
    });
});

// Return ALL tools, with optional paging
app.get('/tools', (req, res) => {
    const tools = Object.entries(getAllTools()).map(([name, info]) => ({
        name,
        description: info.description,
        method: info.method,
        path: info.path,
        api: info.api,
        baseUrl: info.baseUrl,
    }));

    res.json({
        total: tools.length,
        tools, // no slice → no limit
    });
});


app.post('/specs/validate', async (req, res) => {
    try {
        const { spec } = req.body;
        const parsed = await SwaggerParser.validate(spec);
        res.json({ valid: true, spec: parsed });
    } catch (e) {
        res.status(400).json({ valid: false, error: e.message });
    }
});

// ===== STARTUP =====
async function start() {
    console.log('🚀 Starting 3DX AI Gateway...');
    console.log('☁️ Azure Config:', {
        deployment: deploymentName,
        endpoint: endpoint ? '✅ Set' : '❌ Missing',
    });

    const apisLoaded = await loadSpecs();
    getAllTools(); // build global.toolCache
    await registerExecutorTools();

    const PORT = process.env.PORT || 3000;
    const host = process.env.HOST || '0.0.0.0';

    app.listen(PORT, host, () => {
        console.log(`\n🎉 3DX AI Gateway v1.0.0 is LIVE!`);
        console.log(
            `📍 http://${host === '0.0.0.0' ? 'localhost' : host}:${PORT}`
        );
        console.log(
            `💬 Chat: POST /chat {"message": "get all users", "conversation": []}`
        );
        console.log(`🔧 MCP: POST/GET /mcp`);
        console.log(`📊 Health: GET /health`);
        console.log(`🔍 Tools: GET /tools`);
        console.log(`📁 APIs loaded: ${apisLoaded}`);
        console.log(`🛠️ Total tools: ${Object.keys(getAllTools()).length}`);
        console.log(`☁️ Azure OpenAI: ${deploymentName}\n`);
    });
}

start().catch((error) => {
    console.error('💥 Startup failed:', error);
    process.exit(1);
});
