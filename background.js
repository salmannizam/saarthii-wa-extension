// In-memory cache: key -> { timestamp, result }
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes
const lookupCache = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) return false;

  if (message.type === "SAARTHII_CLEAR_CACHE") {
    lookupCache.clear();
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "SAARTHII_LOOKUP") {
    handlePhoneLookup(message)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({
          state: "error",
          message: err?.message || "Failed to contact Saarthii API"
        })
      );
    return true;
  }

  if (message.type === "SAARTHII_ADD_COMMENT") {
    handleAddComment(message)
      .then((result) => sendResponse(result))
      .catch((err) =>
        sendResponse({
          ok: false,
          message: err?.message || "Failed to submit comment to Saarthii API"
        })
      );
    return true;
  }

  return false;
});

async function getSettings() {
  return chrome.storage.local.get({
    apiUrl: "",
    apiKey: "",
    httpMethod: "GET",
    phoneParam: "phone",
    authHeader: "x-api-key",
    commentApiUrl: "",
    commentParam: "comment"
  });
}

async function handlePhoneLookup({ phone10, fullPhone, forceRefresh }) {
  const cacheKey = phone10 || fullPhone;
  if (!cacheKey) {
    return { state: "error", message: "Invalid phone number" };
  }

  if (!forceRefresh && lookupCache.has(cacheKey)) {
    const cached = lookupCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL_MS) {
      return cached.result;
    }
    lookupCache.delete(cacheKey);
  }

  const config = await getSettings();
  const apiUrl = (config.apiUrl || "").trim();
  const apiKey = (config.apiKey || "").trim();
  const httpMethod = (config.httpMethod || "GET").toUpperCase();
  const phoneParam = (config.phoneParam || "phone").trim();
  const authHeader = (config.authHeader || "x-api-key").trim();

  if (!apiUrl) {
    return {
      state: "unconfigured",
      phone10,
      fullPhone,
      message: "Configure Saarthii API URL & Key in extension popup"
    };
  }

  const headers = {
    Accept: "application/json"
  };

  if (apiKey && authHeader) {
    headers[authHeader] = apiKey;
  }

  let fetchUrl = apiUrl;
  const fetchOptions = {
    method: httpMethod,
    headers
  };

  if (httpMethod === "POST") {
    headers["Content-Type"] = "application/json";
    fetchOptions.body = JSON.stringify({
      [phoneParam]: phone10,
      fullPhone: fullPhone
    });
  } else {
    try {
      const urlObj = new URL(apiUrl);
      urlObj.searchParams.set(phoneParam, phone10);
      fetchUrl = urlObj.toString();
    } catch {
      const separator = apiUrl.includes("?") ? "&" : "?";
      fetchUrl = `${apiUrl}${separator}${encodeURIComponent(phoneParam)}=${encodeURIComponent(phone10)}`;
    }
  }

  let response;
  try {
    response = await fetch(fetchUrl, fetchOptions);
  } catch (networkErr) {
    return {
      state: "error",
      phone10,
      fullPhone,
      message: `API Network Error (${networkErr.message || "Check URL/CORS"})`
    };
  }

  if (response.status === 404) {
    const notFoundResult = { state: "not_found", phone10, fullPhone, allDetails: [], comments: [] };
    lookupCache.set(cacheKey, { timestamp: Date.now(), result: notFoundResult });
    return notFoundResult;
  }

  if (response.status === 401 || response.status === 403) {
    return {
      state: "unconfigured",
      phone10,
      fullPhone,
      message: `Saarthii API Auth Failed (HTTP ${response.status}) — Check API Key in popup`
    };
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    if (!response.ok) {
      return {
        state: "error",
        phone10,
        fullPhone,
        message: `Saarthii API Error (HTTP ${response.status})`
      };
    }
  }

  const parsed = parseSaarthiiResponse(payload, response.ok, phone10, fullPhone);
  lookupCache.set(cacheKey, { timestamp: Date.now(), result: parsed });
  return parsed;
}

async function handleAddComment({ phone10, fullPhone, comment, recordId, extraMeta }) {
  const config = await getSettings();
  const commentApiUrl = (config.commentApiUrl || "").trim();
  const apiKey = (config.apiKey || "").trim();
  const phoneParam = (config.phoneParam || "phone").trim();
  const commentParam = (config.commentParam || "comment").trim();
  const authHeader = (config.authHeader || "x-api-key").trim();

  if (!commentApiUrl) {
    return {
      ok: false,
      message: "Set 'Add Comment API Endpoint URL' in extension popup first."
    };
  }

  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json"
  };

  if (apiKey && authHeader) {
    headers[authHeader] = apiKey;
  }

  const bodyPayload = {
    [phoneParam]: phone10,
    phone: phone10,
    fullPhone: fullPhone,
    [commentParam]: comment,
    comment: comment,
    remark: comment,
    note: comment,
    source: "whatsapp_extension",
    timestamp: new Date().toISOString()
  };

  if (recordId) {
    bodyPayload.id = recordId;
    bodyPayload.userId = recordId;
    bodyPayload.agentId = recordId;
    bodyPayload.clientId = recordId;
  }

  if (extraMeta && typeof extraMeta === "object") {
    Object.assign(bodyPayload, extraMeta);
  }

  let response;
  try {
    response = await fetch(commentApiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(bodyPayload)
    });
  } catch (err) {
    return {
      ok: false,
      message: `Network error posting comment: ${err.message || "Check URL"}`
    };
  }

  let respJson = null;
  try {
    respJson = await response.json();
  } catch {
    // Non-JSON response is fine if HTTP status is 2xx
  }

  if (!response.ok || (respJson && (respJson.status === false || respJson.success === false))) {
    const errMsg =
      respJson?.message ||
      respJson?.error ||
      `Failed to add comment (HTTP ${response.status})`;
    return { ok: false, message: errMsg };
  }

  // Update cached lookup comments if cached
  const cacheKey = phone10 || fullPhone;
  if (lookupCache.has(cacheKey)) {
    const cached = lookupCache.get(cacheKey);
    if (cached && cached.result) {
      const existingComments = Array.isArray(cached.result.comments) ? cached.result.comments : [];
      existingComments.unshift({
        text: comment,
        createdAt: new Date().toLocaleString(),
        author: "You (WhatsApp)"
      });
      cached.result.comments = existingComments;
    }
  }

  return {
    ok: true,
    message: respJson?.message || "Comment added to Saarthii Portal!",
    data: respJson
  };
}

function parseSaarthiiResponse(payload, isHttpOk, phone10, fullPhone) {
  if (!payload || typeof payload !== "object") {
    return { state: "not_found", phone10, fullPhone, allDetails: [], comments: [] };
  }

  if (
    payload.status === false ||
    payload.success === false ||
    payload.found === false ||
    payload.statusCode === 404
  ) {
    return { state: "not_found", phone10, fullPhone, allDetails: [], comments: [] };
  }

  let record = payload.data ?? payload.result ?? payload.user ?? payload.agent ?? payload.client ?? payload;

  if (Array.isArray(record)) {
    if (record.length === 0) {
      return { state: "not_found", phone10, fullPhone, allDetails: [], comments: [] };
    }
    record = record[0];
  }

  if (record && typeof record === "object" && !Array.isArray(record)) {
    const inner = record.user || record.agent || record.client || record.profile || record.details;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      record = { ...record, ...inner };
    }
  }

  if (!record || typeof record !== "object" || Object.keys(record).length === 0) {
    return { state: "not_found", phone10, fullPhone, allDetails: [], comments: [] };
  }

  const recordId =
    record.id ||
    record._id ||
    record.userId ||
    record.agentId ||
    record.clientId ||
    null;

  const name =
    pickFirstString(record, [
      "name",
      "fullName",
      "full_name",
      "userName",
      "user_name",
      "agentName",
      "agent_name",
      "clientName",
      "client_name",
      "contactName",
      "firstName"
    ]) || pickFirstString(payload, ["name", "fullName", "userName", "agentName"]);

  const agency =
    pickFirstString(record, [
      "agencyName",
      "agency_name",
      "companyName",
      "company_name",
      "agency",
      "company",
      "organization",
      "orgName",
      "firmName",
      "businessName"
    ]) || pickFirstString(payload, ["agencyName", "companyName", "agency", "organization"]);

  const extraCandidateKeys = [
    { key: "role", label: "Role" },
    { key: "userType", label: "Type" },
    { key: "type", label: "Type" },
    { key: "status", label: "Status" },
    { key: "city", label: "City" },
    { key: "location", label: "Location" },
    { key: "rmName", label: "RM" },
    { key: "rm_name", label: "RM" },
    { key: "accountManager", label: "RM" },
    { key: "email", label: "Email" },
    { key: "code", label: "Code" },
    { key: "agentCode", label: "Code" }
  ];

  const extras = [];
  const usedValues = new Set([name, agency].filter(Boolean).map((v) => v.toLowerCase()));

  for (const item of extraCandidateKeys) {
    if (extras.length >= 2) break;
    const val = record[item.key];
    if (typeof val === "string" || typeof val === "number") {
      const strVal = String(val).trim();
      if (
        strVal &&
        strVal.toLowerCase() !== "true" &&
        strVal.toLowerCase() !== "false" &&
        strVal.toLowerCase() !== "success" &&
        strVal.toLowerCase() !== "ok" &&
        !usedValues.has(strVal.toLowerCase())
      ) {
        usedValues.add(strVal.toLowerCase());
        extras.push({ label: item.label, value: strVal });
      }
    }
  }

  // Extract all human-readable fields for the BuyHatke-style Floating Detail Drawer
  const ignoredKeys = new Set([
    "password",
    "token",
    "accessToken",
    "refreshToken",
    "__v",
    "deleted",
    "isDeleted"
  ]);

  const allDetails = [];
  for (const [k, v] of Object.entries(record)) {
    if (ignoredKeys.has(k)) continue;
    if (v === null || v === undefined || v === "") continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      const strVal = String(v).trim();
      if (!strVal) continue;
      allDetails.push({
        key: k,
        label: formatKeyLabel(k),
        value: strVal
      });
    }
  }

  // Extract comments/notes/remarks array if present in the lookup response
  const rawComments =
    record.comments ||
    record.notes ||
    record.remarks ||
    record.activity ||
    payload.comments ||
    [];
  const comments = [];
  if (Array.isArray(rawComments)) {
    for (const c of rawComments.slice(0, 20)) {
      if (typeof c === "string") {
        comments.push({ text: c, createdAt: "", author: "" });
      } else if (c && typeof c === "object") {
        const text = c.comment || c.text || c.note || c.remark || c.message || "";
        if (text) {
          comments.push({
            text: String(text),
            createdAt: c.createdAt || c.created_at || c.date || c.timestamp || "",
            author: c.author || c.createdBy || c.userName || c.by || ""
          });
        }
      }
    }
  } else if (typeof record.remark === "string" || typeof record.notes === "string") {
    const singleNote = record.remark || record.notes;
    if (singleNote.trim()) {
      comments.push({ text: singleNote.trim(), createdAt: "", author: "Portal Note" });
    }
  }

  if (!name && !agency && extras.length === 0 && allDetails.length === 0) {
    return { state: "not_found", phone10, fullPhone, allDetails: [], comments: [] };
  }

  return {
    state: "found",
    recordId,
    phone10,
    fullPhone,
    name: name || "Unnamed Contact",
    agency: agency || "",
    extras,
    allDetails,
    comments
  };
}

function formatKeyLabel(key) {
  return String(key)
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function pickFirstString(obj, keys) {
  if (!obj || typeof obj !== "object") return "";
  for (const k of keys) {
    const val = obj[k];
    if (typeof val === "string" && val.trim()) {
      return val.trim();
    }
  }
  return "";
}
