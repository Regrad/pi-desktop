import type { Attachment, ConversationSnapshot, JsonObject } from "../../shared/types.js";
export function startControlApi(options: {
  dataDir: string;
  backend: {
    projects(): unknown;
    chats(): unknown;
    attachments(paths: string[]): Promise<Attachment[]>;
    create(projectId?: string): Promise<ConversationSnapshot>;
    inspect(id: string): Promise<ConversationSnapshot>;
    select(id: string): Promise<void>;
    prompt(id: string, message: string, attachments: Attachment[]): Promise<void>;
    abort(id: string): Promise<void>;
    reply(id: string, response: JsonObject): void;
  };
}): Promise<{ connection: { url: string; token: string; pid: number }; settled(id: string, snapshot: ConversationSnapshot): void; close(): Promise<void> }>;
