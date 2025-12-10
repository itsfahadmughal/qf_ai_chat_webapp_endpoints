type HotelRecord = { id: string; name: string };
type UserRecord = { id: string; email: string; hotelId: string };
type PromptRecord = { id: string; hotelId: string; title: string };
type ConversationRecord = {
  id: string;
  title: string | null;
  provider: string;
  model: string;
  userId: string;
  hotelId: string;
  promptId: string | null;
  createdAt: Date;
  updatedAt: Date;
  archived: boolean;
};
type MessageRecord = {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: Date;
  provider: string | null;
  model: string | null;
};
type ProviderToggleRecord = {
  id: string;
  hotelId: string;
  provider: string;
  isEnabled: boolean;
  defaultModel: string | null;
};
type UserPreferenceRecord = {
  userId: string;
  enabledProviders: string[];
  defaultProvider: string | null;
  modelOpenAI: string | null;
  modelDeepseek: string | null;
  modelPerplexity: string | null;
  modelClaude: string | null;
  locale: string | null;
};

const state = {
  hotels: [] as HotelRecord[],
  users: [] as UserRecord[],
  prompts: [] as PromptRecord[],
  conversations: [] as ConversationRecord[],
  messages: [] as MessageRecord[],
  toggles: [] as ProviderToggleRecord[],
  preferences: [] as UserPreferenceRecord[]
};

let seq = 0;
const genId = () => `test-${++seq}`;

export function resetTestState() {
  state.hotels = [];
  state.users = [];
  state.prompts = [];
  state.conversations = [];
  state.messages = [];
  state.toggles = [];
  state.preferences = [];
  seq = 0;
}

export function createHotel(data: { name: string }) {
  const hotel: HotelRecord = { id: genId(), name: data.name };
  state.hotels.push(hotel);
  state.toggles.push({
    id: genId(),
    hotelId: hotel.id,
    provider: "openai",
    isEnabled: true,
    defaultModel: null
  });
  return hotel;
}

export function createUser(data: { email: string; hotelId: string }) {
  const user: UserRecord = { id: genId(), email: data.email, hotelId: data.hotelId };
  state.users.push(user);
  return user;
}

export function createConversationRecord(data: {
  userId: string;
  hotelId: string;
  title?: string | null;
  provider?: string;
  model?: string;
  promptId?: string | null;
}) {
  const now = new Date();
  const conversation: ConversationRecord = {
    id: genId(),
    title: data.title ?? null,
    provider: data.provider ?? "openai",
    model: data.model ?? "gpt-4o-mini",
    userId: data.userId,
    hotelId: data.hotelId,
    promptId: data.promptId ?? null,
    createdAt: now,
    updatedAt: now,
    archived: false
  };
  state.conversations.push(conversation);
  return conversation;
}

export function createMessageRecord(data: {
  conversationId: string;
  role: string;
  content: string;
  provider?: string | null;
  model?: string | null;
}) {
  const message: MessageRecord = {
    id: genId(),
    conversationId: data.conversationId,
    role: data.role,
    content: data.content,
    createdAt: new Date(),
    provider: data.provider ?? null,
    model: data.model ?? null
  };
  state.messages.push(message);
  return message;
}

function applySelect<T extends Record<string, any>>(record: T, select?: Record<string, boolean>) {
  if (!select) return record;
  const partial: Record<string, any> = {};
  for (const key of Object.keys(select)) {
    if (select[key] && key in record) {
      partial[key] = record[key];
    }
  }
  return partial as T;
}

function matchConversation(record: ConversationRecord, where: any = {}) {
  if (where.id && record.id !== where.id) return false;
  if (where.userId && record.userId !== where.userId) return false;
  if (where.hotelId && record.hotelId !== where.hotelId) return false;
  if (where.promptId !== undefined) {
    if (where.promptId === null && record.promptId !== null) return false;
    if (where.promptId && record.promptId !== where.promptId) return false;
  }
  if (where.archived !== undefined && record.archived !== where.archived) return false;
  return true;
}

function matchMessage(record: MessageRecord, where: any = {}) {
  if (where.conversationId && record.conversationId !== where.conversationId) return false;
  if (where.role && record.role !== where.role) return false;
  if (where.NOT?.role && record.role === where.NOT.role) return false;
  return true;
}

export const prismaMock = {
  $transaction: async (ops: any[]) => {
    for (const op of ops) await op;
  },
  hotel: {
    async create({ data }: { data: { name: string } }) {
      return createHotel(data);
    }
  },
  user: {
    async create({ data }: { data: { email: string; passwordHash: string; hotelId: string } }) {
      return createUser({ email: data.email, hotelId: data.hotelId });
    },
    async findUnique({ where, select }: any) {
      const user = state.users.find((u) => u.id === where.id);
      return user ? applySelect(user, select) : null;
    }
  },
  prompt: {
    async findFirst({ where }: any) {
      return state.prompts.find((p) => p.id === where.id && p.hotelId === where.hotelId) ?? null;
    }
  },
  hotelProviderToggle: {
    async findMany({ where, select }: any) {
      return state.toggles
        .filter((t) => t.hotelId === where.hotelId && (where.isEnabled === undefined || t.isEnabled === where.isEnabled))
        .map((t) => applySelect(t, select));
    }
  },
  userPreference: {
    async findUnique({ where }: any) {
      return state.preferences.find((p) => p.userId === where.userId) ?? null;
    },
    async upsert({ where, create, update }: any) {
      const existing = state.preferences.find((p) => p.userId === where.userId);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const pref: UserPreferenceRecord = {
        userId: where.userId,
        enabledProviders: create.enabledProviders ?? [],
        defaultProvider: create.defaultProvider ?? null,
        modelOpenAI: create.modelOpenAI ?? null,
        modelDeepseek: create.modelDeepseek ?? null,
        modelPerplexity: create.modelPerplexity ?? null,
        modelClaude: create.modelClaude ?? null,
        locale: create.locale ?? null
      };
      state.preferences.push(pref);
      return pref;
    }
  },
  fineTuneModel: {
    async findFirst() {
      return null;
    }
  },
  conversation: {
    async create({ data, select }: any) {
      const conversation = createConversationRecord({
        userId: data.user.connect.id,
        hotelId: data.hotel.connect.id,
        title: data.title,
        provider: data.provider,
        model: data.model,
        promptId: data.prompt?.connect?.id ?? null
      });
      return applySelect(conversation, select);
    },
    async findFirst({ where, select }: any) {
      const record = state.conversations.find((conv) => matchConversation(conv, where));
      return record ? applySelect(record, select) : null;
    },
    async findMany({ where = {}, orderBy, select }: any) {
      let results = state.conversations.filter((conv) => matchConversation(conv, where));
      if (orderBy?.updatedAt === "desc") {
        results = [...results].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      } else if (orderBy?.updatedAt === "asc") {
        results = [...results].sort((a, b) => a.updatedAt.getTime() - b.updatedAt.getTime());
      }
      return results.map((conv) => applySelect(conv, select));
    },
    async update({ where, data }: any) {
      const record = state.conversations.find((conv) => conv.id === where.id);
      if (!record) throw new Error("Conversation not found");
      Object.assign(record, data, { updatedAt: new Date() });
      return record;
    },
    async delete({ where }: any) {
      const idx = state.conversations.findIndex((conv) => conv.id === where.id);
      if (idx >= 0) {
        const [removed] = state.conversations.splice(idx, 1);
        return removed;
      }
      throw new Error("Conversation not found");
    }
  },
  message: {
    async findMany({ where = {}, orderBy }: any) {
      let results = state.messages.filter((msg) => matchMessage(msg, where));
      if (orderBy?.createdAt === "asc") {
        results = [...results].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      } else if (orderBy?.createdAt === "desc") {
        results = [...results].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      return results;
    },
    async createMany({ data }: any) {
      const entries = Array.isArray(data) ? data : [data];
      for (const entry of entries) {
        createMessageRecord({
          conversationId: entry.conversationId,
          role: entry.role,
          content: entry.content,
          provider: entry.provider ?? null,
          model: entry.model ?? null
        });
      }
      return { count: entries.length };
    },
    async create({ data }: any) {
      return createMessageRecord({
        conversationId: data.conversationId,
        role: data.role,
        content: data.content,
        provider: data.provider ?? null,
        model: data.model ?? null
      });
    },
    async deleteMany({ where }: any) {
      const before = state.messages.length;
      state.messages = state.messages.filter((msg) => !matchMessage(msg, where));
      return { count: before - state.messages.length };
    }
  },
  conversationFile: {
    async findMany() {
      return [];
    }
  },
  hotelProviderCredential: {
    async findUnique() {
      return null;
    }
  },
  hotelVectorStore: {
    async findFirst() {
      return null;
    }
  },
  toolCallLog: {
    async create({ data }: any) {
      return { id: genId(), ...data };
    }
  }
} as any;

export const testState = state;
