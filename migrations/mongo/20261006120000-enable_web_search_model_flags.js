/**
 * Migration: Make provider-native web search DB-driven
 *
 * The Python repo no longer hardcodes web search per provider. It reads two fields:
 *
 *   - services.web_search_tool: how each provider expects web search, in the shapes already used
 *     by 20260723120000-add_web_search_tool_to_services:
 *       { unfiltered: tool, filtered: tool, max_domains? }  tool entries; `filtered` is used when the
 *                                                          agent sets allowed domains, and every
 *                                                          `allowed_domains: null` in it receives them
 *       tool                                                a single tool entry used as-is
 *       { extra_body }                                      merged into extra_body (OpenRouter plugin)
 *     plus an optional `endpoint` ("/responses"): the path under the service's base_url that web search
 *     requests must go to, for providers that only serve web search there (Grok, MiniMax).
 *   - modelconfigurations.validationConfig.inbuilt_tools.web_search: whether a model supports it.
 *     This is now the only per-model switch in code (it replaces model-name prefixes and the
 *     "has tools" checks), so it is set here on every model that gets web search today, plus the
 *     newly supported providers:
 *
 *       openai, anthropic -> models with tools in their configuration (unchanged behavior)
 *       gemini            -> chat models with tools (google_search grounding)
 *       moonshot          -> chat models with tools ($web_search builtin_function)
 *       groq              -> GPT-OSS models (server-side browser_search)
 *       open_router       -> any chat model (the "web" plugin)
 *       grok              -> grok-4 family (xAI web_search on the Responses API)
 *       minimax           -> MiniMax-M3 models (M2.x leak plugin_web_search instead of searching)
 *
 * The "Web Search" entry is also added to services.in_built_tools where missing so the UI offers it.
 *
 * Models are selected by query rather than by name so the migration does the right thing in every
 * environment. Previous values are saved in the `migration_backups` collection so `down` restores
 * each environment exactly.
 *
 * Deploy this before (or with) the Python change: until it runs, models without the flag get no
 * provider-native web search.
 *
 * @param db {import('mongodb').Db}
 * @param client {import('mongodb').MongoClient}
 * @returns {Promise<void>}
 */

const MIGRATION_ID = "20261006120000-enable_web_search_model_flags";

// Which models get validationConfig.inbuilt_tools.web_search = true, per provider.
const WEB_SEARCH_MODEL_FILTERS = [
  {
    service: "openai",
    "configuration.tools": { $exists: true }
  },
  {
    service: "anthropic",
    "configuration.tools": { $exists: true }
  },
  {
    service: "gemini",
    "validationConfig.type": "chat",
    "validationConfig.tools": true,
    "configuration.tools": { $exists: true }
  },
  {
    service: "moonshot",
    "validationConfig.type": "chat",
    "configuration.tools": { $exists: true }
  },
  {
    service: "groq",
    model_name: { $regex: "^openai/gpt-oss" },
    "validationConfig.tools": true,
    "configuration.tools": { $exists: true }
  },
  {
    service: "open_router",
    "validationConfig.type": "chat"
  },
  {
    service: "grok",
    "validationConfig.type": "chat",
    model_name: { $regex: "^grok-4" }
  },
  {
    // MiniMax documents server tools with MiniMax-M3 only; leave the M2.x models off
    service: "minimax",
    "validationConfig.type": "chat",
    model_name: { $regex: "^minimax-m3", $options: "i" },
    "configuration.tools": { $exists: true }
  }
];

const WEB_SEARCH_IN_BUILT_TOOL = {
  name: "Web Search",
  description: "Allow models to search the web for the latest information before generating a response.",
  value: "web_search"
};

const SERVICE_WEB_SEARCH_TOOLS = {
  openai: {
    unfiltered: { type: "web_search_preview" },
    filtered: { type: "web_search", filters: { allowed_domains: null } }
  },
  anthropic: {
    unfiltered: { type: "web_search_20250305", name: "web_search" },
    filtered: { type: "web_search_20250305", name: "web_search", allowed_domains: null }
  },
  gemini: { google_search: {} },
  open_router: { extra_body: { plugins: [{ id: "web" }] } },
  moonshot: { type: "builtin_function", function: { name: "$web_search" } },
  groq: { type: "browser_search" },
  grok: {
    unfiltered: { type: "web_search" },
    filtered: { type: "web_search", filters: { allowed_domains: null } },
    max_domains: 5,
    endpoint: "/responses"
  },
  minimax: { unfiltered: { type: "web_search" }, endpoint: "/responses" }
};

export const up = async (db) => {
  const models = db.collection("modelconfigurations");
  const services = db.collection("services");

  const docs = await models
    .find(
      {
        $or: WEB_SEARCH_MODEL_FILTERS,
        "validationConfig.inbuilt_tools.web_search": { $ne: true }
      },
      { projection: { service: 1, model_name: 1, "validationConfig.inbuilt_tools": 1 } }
    )
    .toArray();

  const modelBackups = docs.map((doc) => {
    const inbuiltTools = doc.validationConfig?.inbuilt_tools;
    const hasInbuiltTools = inbuiltTools !== undefined && inbuiltTools !== null;
    return {
      _id: doc._id,
      service: doc.service,
      model_name: doc.model_name,
      inbuilt_tools: hasInbuiltTools ? inbuiltTools : inbuiltTools === null ? null : "__missing__",
      had_web_search: hasInbuiltTools && Object.prototype.hasOwnProperty.call(inbuiltTools, "web_search")
    };
  });

  const modelOps = docs.map((doc) => {
    const inbuiltTools = doc.validationConfig?.inbuilt_tools;
    // A null inbuilt_tools cannot take a nested $set, so write the whole object.
    const update =
      inbuiltTools && typeof inbuiltTools === "object"
        ? { $set: { "validationConfig.inbuilt_tools.web_search": true } }
        : { $set: { "validationConfig.inbuilt_tools": { web_search: true } } };
    return { updateOne: { filter: { _id: doc._id }, update } };
  });

  const serviceDocs = await services
    .find({ service_name: { $in: Object.keys(SERVICE_WEB_SEARCH_TOOLS) } })
    .project({ service_name: 1, in_built_tools: 1, web_search_tool: 1 })
    .toArray();

  const serviceBackups = serviceDocs.map((doc) => ({
    service_name: doc.service_name,
    in_built_tools: doc.in_built_tools === undefined ? "__missing__" : doc.in_built_tools,
    web_search_tool: doc.web_search_tool === undefined ? "__missing__" : doc.web_search_tool
  }));

  const serviceOps = serviceDocs.map((doc) => {
    const inBuiltTools = Array.isArray(doc.in_built_tools) ? doc.in_built_tools : [];
    const hasWebSearch = inBuiltTools.some((tool) => tool?.value === "web_search");
    return {
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            in_built_tools: hasWebSearch ? inBuiltTools : [...inBuiltTools, WEB_SEARCH_IN_BUILT_TOOL],
            web_search_tool: SERVICE_WEB_SEARCH_TOOLS[doc.service_name]
          }
        }
      }
    };
  });

  await db
    .collection("migration_backups")
    .updateOne({ _id: MIGRATION_ID }, { $set: { models: modelBackups, services: serviceBackups, created_at: new Date() } }, { upsert: true });

  const modelResult = modelOps.length ? await models.bulkWrite(modelOps, { ordered: false }) : { modifiedCount: 0 };
  const serviceResult = serviceOps.length ? await services.bulkWrite(serviceOps, { ordered: false }) : { modifiedCount: 0 };

  console.log(`Enabled web_search on ${modelResult.modifiedCount} models: ` + modelBackups.map((m) => `${m.service}/${m.model_name}`).join(", "));
  console.log(`Added Web Search to ${serviceResult.modifiedCount} services.`);
};

/**
 * @param db {import('mongodb').Db}
 * @param client {import('mongodb').MongoClient}
 * @returns {Promise<void>}
 */
export const down = async (db) => {
  const backup = await db.collection("migration_backups").findOne({ _id: MIGRATION_ID });
  if (!backup) {
    console.log(`No backup found for ${MIGRATION_ID}; nothing to restore.`);
    return;
  }

  const modelOps = (backup.models || []).map((model) => {
    let update;
    if (model.inbuilt_tools === "__missing__") {
      update = { $unset: { "validationConfig.inbuilt_tools": "" } };
    } else if (model.inbuilt_tools === null) {
      update = { $set: { "validationConfig.inbuilt_tools": null } };
    } else if (model.had_web_search) {
      update = { $set: { "validationConfig.inbuilt_tools.web_search": model.inbuilt_tools.web_search } };
    } else {
      update = { $unset: { "validationConfig.inbuilt_tools.web_search": "" } };
    }
    return { updateOne: { filter: { _id: model._id }, update } };
  });

  const serviceOps = (backup.services || []).map((service) => {
    const $set = {};
    const $unset = {};
    for (const field of ["in_built_tools", "web_search_tool"]) {
      if (service[field] === "__missing__") $unset[field] = "";
      else $set[field] = service[field];
    }
    const update = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    return { updateOne: { filter: { service_name: service.service_name }, update } };
  });

  if (modelOps.length) await db.collection("modelconfigurations").bulkWrite(modelOps, { ordered: false });
  if (serviceOps.length) await db.collection("services").bulkWrite(serviceOps, { ordered: false });
  await db.collection("migration_backups").deleteOne({ _id: MIGRATION_ID });

  console.log(`Restored web_search flags on ${modelOps.length} models and ${serviceOps.length} services.`);
};
