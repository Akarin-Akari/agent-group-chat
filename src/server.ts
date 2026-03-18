import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import path from 'path';
import fs from 'fs-extra';
import { FileStore } from './storage/file-store.js';
import { GroupChatManagerImpl } from './manager.js';
import { ToolHandler as AppToolHandler } from './types/index.js';

export class GroupChatServer {
  private mcp: McpServer;
  private manager: GroupChatManagerImpl;
  private toolHandlers: Map<string, AppToolHandler>;

  constructor(fileStore: FileStore) {
    this.mcp = new McpServer(
      { name: 'group-chat', version: '2.0.0' },
      { capabilities: { tools: {} } }
    );

    this.manager = new GroupChatManagerImpl(fileStore);
    this.toolHandlers = new Map();

    this.registerTools();
  }

  private registerTools(): void {
    const toolsDir = path.join(__dirname, 'tools');
    const toolFiles = fs.readdirSync(toolsDir).filter(
      (file: string) => (file.endsWith('.ts') || file.endsWith('.js')) && !file.endsWith('.d.ts')
    );

    for (const file of toolFiles) {
      // Skip relay-common — it's a shared utility, not a tool
      if (file.startsWith('relay-common')) continue;

      try {
        const toolModule = require(path.join(toolsDir, file));
        if (toolModule.toolDefinition && toolModule.toolHandler) {
          const def = toolModule.toolDefinition;
          const handler = toolModule.toolHandler;

          const inputSchema = this.jsonSchemaToZod(def.inputSchema);

          this.mcp.tool(
            def.name,
            def.description || '',
            inputSchema.shape,
            async (input: any) => {
              try {
                const result = await handler(
                  { toolName: def.name, input },
                  this.manager
                );

                let outputText = '';
                if (typeof result.message === 'string') {
                  outputText = result.message;
                } else if (result.message !== undefined && result.message !== null) {
                  outputText = JSON.stringify(result.message, null, 2);
                }

                if (!outputText) {
                  outputText = JSON.stringify(result, null, 2);
                }

                return {
                  content: [{ type: 'text' as const, text: outputText }],
                };
              } catch (error: any) {
                console.error(`[group-chat] Error in tool ${def.name}:`, error);
                return {
                  content: [
                    {
                      type: 'text' as const,
                      text: JSON.stringify({ error: error.message || 'Unknown error' }, null, 2),
                    },
                  ],
                  isError: true,
                } as any;
              }
            }
          );

          this.toolHandlers.set(def.name, handler);
          console.error(`[group-chat] Registered tool: ${def.name}`);
        }
      } catch (err: any) {
        console.error(`[group-chat] Failed to load tool ${file}:`, err.message);
      }
    }
  }

  private jsonSchemaToZod(schema: any): z.ZodObject<any> {
    const shape: any = {};

    if (schema.properties) {
      for (const [key, prop] of Object.entries<any>(schema.properties)) {
        let zodType: any;

        switch (prop.type) {
          case 'string':
            zodType = z.string();
            break;
          case 'number':
            zodType = z.number();
            break;
          case 'boolean':
            zodType = z.boolean();
            break;
          case 'array':
            zodType = prop.items?.type === 'string' ? z.array(z.string()) : z.array(z.any());
            break;
          default:
            zodType = z.any();
        }

        if (prop.description) {
          zodType = zodType.describe(prop.description);
        }

        if (!schema.required || !schema.required.includes(key)) {
          zodType = zodType.optional();
        }

        shape[key] = zodType;
      }
    }

    return z.object(shape);
  }

  public async start(): Promise<void> {
    const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
    console.error('[group-chat] Starting Group Chat MCP Server v2.0 (MD-as-ground-truth)...');
    const transport = new StdioServerTransport();
    await this.mcp.connect(transport);
    console.error('[group-chat] Server started and listening for tool calls.');
  }

  public getManager(): GroupChatManagerImpl {
    return this.manager;
  }
}
