const QUERY_PREF_KEY = "pk_query";

function extractKeyword(payload) {
  if (typeof payload !== "string") return "";
  const text = payload.trim();
  const matched = text.match(/^(?:杀进程|结束进程|进程|内存|prockill|pk|kill)[\s:：]+(\S.*)$/i);
  return (matched ? matched[1] : text).trim().slice(0, 200);
}

function resolveEntryQuery(entry, savedQuery) {
  const { type, payload } = entry || {};
  if (type === "regex" || type === "over") return extractKeyword(payload);
  return String(savedQuery || "").slice(0, 200);
}

module.exports = { QUERY_PREF_KEY, extractKeyword, resolveEntryQuery };
