type ProviderName = "openai" | "deepseek" | "perplexity" | "claude";

type HotelRecord = {
  id: string;
  name: string;
  isActive: boolean;
};

type UserRecord = {
  id: string;
  email: string;
  hotelId: string;
  role: "author" | "reader";
  isActive: boolean;
  departmentId: string | null;
  createdAt: Date;
};

type DepartmentRecord = { id: string; hotelId: string; name: string };

type PromptCategoryRecord = { id: string; hotelId: string; name: string };

type PromptRecord = {
  id: string;
  hotelId: string;
  authorId: string;
  title: string;
  body: string;
  tags: string[];
  version: string | null;
  categoryId: string | null;
  departmentId: string | null;
  assignedUserIds: string[];
  archived: boolean;
  createdAt: Date;
  updatedAt: Date;
};

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
  provider: ProviderName;
  isEnabled: boolean;
  defaultModel: string | null;
};

type UserPreferenceRecord = {
  userId: string;
  enabledProviders: ProviderName[];
  defaultProvider: ProviderName | null;
  modelOpenAI: string | null;
  modelDeepseek: string | null;
  modelPerplexity: string | null;
  modelClaude: string | null;
  locale: string | null;
};

type VectorStoreRecord = {
  id: string;
  hotelId: string;
  openaiId: string;
  isDefault: boolean;
  createdAt: Date;
};

const state = {
  hotels: [] as HotelRecord[],
  users: [] as UserRecord[],
  departments: [] as DepartmentRecord[],
  prompts: [] as PromptRecord[],
  promptCategories: [] as PromptCategoryRecord[],
  conversations: [] as ConversationRecord[],
  messages: [] as MessageRecord[],
  toggles: [] as ProviderToggleRecord[],
  preferences: [] as UserPreferenceRecord[],
  vectorStores: [] as VectorStoreRecord[]
};

export const testState = state;

let seq = 0;
const genId = () => `test-${++seq}`;

export function resetTestState() {
  state.hotels = [];
  state.users = [];
  state.departments = [];
  state.prompts = [];
  state.promptCategories = [];
  state.conversations = [];
  state.messages = [];
  state.toggles = [];
  state.preferences = [];
  state.vectorStores = [];
  seq = 0;
}

export function createHotel({ name, isActive = true }: { name: string; isActive?: boolean }) {
  const hotel: HotelRecord = { id: genId(), name, isActive };
  state.hotels.push(hotel);
  setProviderToggle(hotel.id, "openai", { isEnabled: true });
  return hotel;
}

export function createUser(opts: {
  email: string;
  hotelId: string;
  role?: "author" | "reader";
  isActive?: boolean;
  departmentId?: string | null;
}) {
  const user: UserRecord = {
    id: genId(),
    email: opts.email,
    hotelId: opts.hotelId,
    role: opts.role ?? "reader",
    isActive: opts.isActive ?? true,
    departmentId: opts.departmentId ?? null,
    createdAt: new Date()
  };
  state.users.push(user);
  return user;
}

export function createDepartment({ hotelId, name }: { hotelId: string; name: string }) {
  const department: DepartmentRecord = { id: genId(), hotelId, name };
  state.departments.push(department);
  return department;
}

export function setProviderToggle(
  hotelId: string,
  provider: ProviderName,
  opts: { isEnabled?: boolean; defaultModel?: string | null } = {}
) {
  const existing = state.toggles.find((t) => t.hotelId === hotelId && t.provider === provider);
  if (existing) {
    if (opts.isEnabled !== undefined) existing.isEnabled = opts.isEnabled;
    if (opts.defaultModel !== undefined) existing.defaultModel = opts.defaultModel ?? null;
    return existing;
  }
  const record: ProviderToggleRecord = {
    id: genId(),
    hotelId,
    provider,
    isEnabled: opts.isEnabled ?? true,
    defaultModel: opts.defaultModel ?? null
  };
  state.toggles.push(record);
  return record;
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

export function createVectorStore({
  hotelId,
  openaiId,
  isDefault = true
}: {
  hotelId: string;
  openaiId: string;
  isDefault?: boolean;
}) {
  const record: VectorStoreRecord = {
    id: genId(),
    hotelId,
    openaiId,
    isDefault,
    createdAt: new Date()
  };
  state.vectorStores.push(record);
  return record;
}

function clone<T extends Record<string, any>>(record: T): T {
  return { ...record };
}

function withHotel(record: { hotelId: string } & Record<string, any>) {
  return {
    ...record,
    hotel: state.hotels.find((h) => h.id === record.hotelId) ?? null
  };
}

function withDepartment(record: { departmentId: string | null } & Record<string, any>) {
  if (!record.departmentId) return { ...record, department: null };
  const department = state.departments.find((d) => d.id === record.departmentId) || null;
  return { ...record, department };
}

function promptWithRelations(prompt: PromptRecord) {
  const author = state.users.find((u) => u.id === prompt.authorId) || null;
  const category = prompt.categoryId
    ? state.promptCategories.find((c) => c.id === prompt.categoryId) ?? null
    : null;
  const department = prompt.departmentId
    ? state.departments.find((d) => d.id === prompt.departmentId) ?? null
    : null;
  const assignedUsers = prompt.assignedUserIds
    .map((id) => state.users.find((u) => u.id === id))
    .filter(Boolean)
    .map((u) => ({ id: u!.id, email: u!.email }));
  return {
    ...prompt,
    author: author ? { id: author.id, email: author.email } : null,
    category: category ? { id: category.id, name: category.name } : null,
    department: department ? { id: department.id, name: department.name } : null,
    assignedUsers
  };
}

function conversationMatches(record: ConversationRecord, where: any = {}) {
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

function messageMatches(record: MessageRecord, where: any = {}) {
  if (where.conversationId && record.conversationId !== where.conversationId) return false;
  if (where.role && record.role !== where.role) return false;
  if (where.NOT?.role && record.role === where.NOT.role) return false;
  return true;
}

function promptMatches(record: PromptRecord, where: any = {}) {
  if (where.hotelId && record.hotelId !== where.hotelId) return false;
  if (where.archived !== undefined && record.archived !== where.archived) return false;
  if (where.categoryId && record.categoryId !== where.categoryId) return false;
  if (where.departmentId && record.departmentId !== where.departmentId) return false;
  if (where.assignedUsers?.some?.id && !record.assignedUserIds.includes(where.assignedUsers.some.id))
    return false;
  if (where.AND) {
    const conditions = Array.isArray(where.AND) ? where.AND : [where.AND];
    for (const condition of conditions) {
      if (condition.OR) {
        const orMatches = condition.OR.some((sub: any) => promptMatches(record, sub));
        if (!orMatches) return false;
      } else if (!promptMatches(record, condition)) {
        return false;
      }
    }
  }
  if (where.OR) {
    return where.OR.some((sub: any) => promptMatches(record, sub));
  }
  if (where.title?.contains) {
    const needle = where.title.contains.toLowerCase();
    if (!record.title.toLowerCase().includes(needle)) return false;
  }
  if (where.body?.contains) {
    const needle = where.body.contains.toLowerCase();
    if (!record.body.toLowerCase().includes(needle)) return false;
  }
  if (where.tags?.has) {
    if (!record.tags.includes(where.tags.has)) return false;
  }
  return true;
}

export const prismaMock = {
  $transaction: async (operations: any[]) => {
    for (const op of operations) {
      await op;
    }
  },
  hotel: {
    async create({ data }: { data: { name: string } }) {
      return createHotel({ name: data.name });
    },
    async findUnique({ where }: any) {
      return state.hotels.find((h) => h.id === where.id) ?? null;
    },
    async findFirst({ where }: any) {
      return state.hotels.find((h) => (!where?.id || h.id === where.id) && (!where?.name || h.name === where.name)) ?? null;
    }
  },
  user: {
    async create({ data }: any) {
      return createUser({
        email: data.email,
        hotelId: data.hotelId,
        role: data.role,
        isActive: data.isActive,
        departmentId: data.departmentId ?? null
      });
    },
    async findUnique({ where, include }: any) {
      const user = state.users.find((u) => u.id === where.id);
      if (!user) return null;
      let result: any = { ...user };
      if (include?.hotel) {
        result.hotel = state.hotels.find((h) => h.id === user.hotelId) ?? null;
      }
      return result;
    },
    async findFirst({ where }: any) {
      return state.users.find((u) => {
        if (where.id && u.id !== where.id) return false;
        if (where.hotelId && u.hotelId !== where.hotelId) return false;
        return true;
      }) ?? null;
    },
    async findMany({ where }: any) {
      return state.users
        .filter((u) => {
          if (where.hotelId && u.hotelId !== where.hotelId) return false;
          if (where.departmentId !== undefined) {
            if (where.departmentId === null && u.departmentId !== null) return false;
            if (where.departmentId && u.departmentId !== where.departmentId) return false;
          }
          if (where.isActive !== undefined && u.isActive !== where.isActive) return false;
          return true;
        })
        .map((u) => {
          const hotel = state.hotels.find((h) => h.id === u.hotelId) ?? null;
          const department = u.departmentId
            ? state.departments.find((d) => d.id === u.departmentId) ?? null
            : null;
          return { ...u, hotel, department };
        });
    },
    async update({ where, data }: any) {
      const user = state.users.find((u) => u.id === where.id);
      if (!user) throw new Error("user not found");
      Object.assign(user, data);
      const hotel = state.hotels.find((h) => h.id === user.hotelId) ?? null;
      const department = user.departmentId
        ? state.departments.find((d) => d.id === user.departmentId) ?? null
        : null;
      return { ...user, hotel, department };
    },
    async delete({ where }: any) {
      const idx = state.users.findIndex((u) => u.id === where.id);
      if (idx === -1) throw new Error("user not found");
      const [removed] = state.users.splice(idx, 1);
      return removed;
    }
  },
  department: {
    async findFirst({ where }: any) {
      return state.departments.find(
        (d) => d.id === where.id && d.hotelId === where.hotelId
      ) ?? null;
    },
    async create({ data }: any) {
      return createDepartment({ hotelId: data.hotelId, name: data.name });
    }
  },
  hotelProviderToggle: {
    async findMany({ where, select }: any) {
      const toggles = state.toggles.filter((t) => {
        if (where.hotelId && t.hotelId !== where.hotelId) return false;
        if (where.isEnabled !== undefined && t.isEnabled !== where.isEnabled) return false;
        return true;
      });
      return toggles.map((toggle) =>
        select
          ? Object.fromEntries(
              Object.keys(select)
                .filter((key) => select[key])
                .map((key) => [key, (toggle as any)[key]])
            )
          : toggle
      );
    },
    async findUnique({ where }: any) {
      return (
        state.toggles.find(
          (t) => t.hotelId === where.hotelId_provider.hotelId && t.provider === where.hotelId_provider.provider
        ) ?? null
      );
    },
    async upsert({ where, create, update }: any) {
      const existing = await prismaMock.hotelProviderToggle.findUnique({ where });
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      const record: ProviderToggleRecord = {
        id: genId(),
        hotelId: where.hotelId_provider.hotelId,
        provider: where.hotelId_provider.provider,
        isEnabled: create.isEnabled ?? true,
        defaultModel: create.defaultModel ?? null
      };
      state.toggles.push(record);
      return record;
    },
    async updateMany({ where, data }: any) {
      state.toggles.forEach((toggle) => {
        if (toggle.hotelId === where.hotelId && toggle.provider === where.provider) {
          Object.assign(toggle, data);
        }
      });
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
  hotelVectorStore: {
    async findFirst({ where, orderBy }: any) {
      let stores = state.vectorStores;
      if (where?.hotelId) stores = stores.filter((s) => s.hotelId === where.hotelId);
      if (where?.isDefault !== undefined) stores = stores.filter((s) => s.isDefault === where.isDefault);
      if (where?.id) stores = stores.filter((s) => s.id === where.id);
      if (orderBy?.createdAt === "asc") {
        stores = [...stores].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      } else if (orderBy?.createdAt === "desc") {
        stores = [...stores].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      }
      return stores[0] ?? null;
    }
  },
  promptCategory: {
    async findMany({ where, orderBy }: any) {
      let categories = state.promptCategories.filter((c) => c.hotelId === where.hotelId);
      if (orderBy?.name === "asc") {
        categories = [...categories].sort((a, b) => a.name.localeCompare(b.name));
      }
      return categories;
    },
    async findFirst({ where }: any) {
      return state.promptCategories.find(
        (c) => c.id === where.id && c.hotelId === where.hotelId
      ) ?? null;
    },
    async upsert({ where, create }: any) {
      const existing = state.promptCategories.find(
        (c) => c.hotelId === where.hotelId_name.hotelId && c.name === where.hotelId_name.name
      );
      if (existing) return existing;
      const category: PromptCategoryRecord = {
        id: genId(),
        hotelId: where.hotelId_name.hotelId,
        name: create.name
      };
      state.promptCategories.push(category);
      return category;
    }
  },
  prompt: {
    async create({ data }: any) {
      const now = new Date();
      const record: PromptRecord = {
        id: genId(),
        hotelId: data.hotel?.connect?.id ?? data.hotelId,
        authorId: data.author?.connect?.id ?? data.authorId,
        title: data.title,
        body: data.body,
        tags: Array.isArray(data.tags) ? data.tags : [],
        version: data.version ?? null,
        categoryId: data.category?.connect?.id ?? data.categoryId ?? null,
        departmentId: data.departmentId ?? null,
        assignedUserIds: Array.isArray(data.assignedUsers?.connect)
          ? data.assignedUsers.connect.map((u: any) => u.id)
          : [],
        archived: false,
        createdAt: now,
        updatedAt: now
      };
      state.prompts.push(record);
      return promptWithRelations(record);
    },
    async findMany({ where, orderBy }: any) {
      let prompts = state.prompts.filter((p) => promptMatches(p, where));
      if (orderBy?.updatedAt === "desc") {
        prompts = [...prompts].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      }
      return prompts.map(promptWithRelations);
    },
    async findFirst({ where }: any) {
      const prompt = state.prompts.find((p) => promptMatches(p, where));
      return prompt ? promptWithRelations(prompt) : null;
    },
    async delete({ where }: any) {
      const idx = state.prompts.findIndex((p) => p.id === where.id);
      if (idx === -1) throw new Error("prompt not found");
      const [removed] = state.prompts.splice(idx, 1);
      return removed;
    }
  },
  promptFeedback: {
    async findMany() {
      return [];
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
      return select ? Object.fromEntries(Object.keys(select).map((key) => [key, (conversation as any)[key]])) : conversation;
    },
    async findFirst({ where, select }: any) {
      const record = state.conversations.find((conv) => conversationMatches(conv, where));
      if (!record) return null;
      return select
        ? Object.fromEntries(Object.keys(select).map((key) => [key, (record as any)[key]]))
        : record;
    },
    async findMany({ where = {}, orderBy, select }: any) {
      let results = state.conversations.filter((conv) => conversationMatches(conv, where));
      if (orderBy?.updatedAt === "desc") {
        results = [...results].sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
      }
      return results.map((record) =>
        select
          ? Object.fromEntries(Object.keys(select).map((key) => [key, (record as any)[key]]))
          : record
      );
    },
    async update({ where, data }: any) {
      const record = state.conversations.find((conv) => conv.id === where.id);
      if (!record) throw new Error("conversation not found");
      Object.assign(record, data, { updatedAt: new Date() });
      return record;
    },
    async delete({ where }: any) {
      const idx = state.conversations.findIndex((conv) => conv.id === where.id);
      if (idx === -1) throw new Error("conversation not found");
      const [removed] = state.conversations.splice(idx, 1);
      return removed;
    }
  },
  message: {
    async findMany({ where = {}, orderBy }: any) {
      let results = state.messages.filter((msg) => messageMatches(msg, where));
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
      state.messages = state.messages.filter((msg) => !messageMatches(msg, where));
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
  hotelVectorStoreFile: {
    async findMany() {
      return [];
    }
  },
  toolCallLog: {
    async create({ data }: any) {
      return { id: genId(), ...data };
    }
  }
} as any;
