/* -------------------- CONFIG READ -------------------- */

function getConfig_(ss) {
  const sh = getConfigSheet_(ss)
  const rows = sh.getDataRange().getValues()

  const config = {}

  for (let i = 1; i < rows.length; i++) {
    const key = String(rows[i][0] || "").trim()
    if (!key) {
      continue
    }

    config[key] = rows[i][1]
  }

  return config
}

function getConfigValue_(ss, key) {
  const sh = getConfigSheet_(ss)
  const rows = sh.getDataRange().getValues()
  const targetKey = String(key || "").trim()

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim() === targetKey) {
      return rows[i][1]
    }
  }

  return ""
}

/* -------------------- CONFIG WRITE -------------------- */

function setConfigValue_(ss, key, value) {
  const sh = getConfigSheet_(ss)
  const rows = sh.getDataRange().getValues()
  const targetKey = String(key || "").trim()

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim() === targetKey) {
      sh.getRange(i + 1, 2).setValue(value)
      return
    }
  }

  sh.appendRow([targetKey, value])
}

/* -------------------- CONFIG HELPERS -------------------- */

function getConfigSheet_(ss) {
  const sh = ss.getSheetByName("bot_config")

  if (!sh) {
    throw new Error("bot_config sheet not found")
  }

  return sh
}

function getBooleanConfig_(config, key, defaultValue) {
  if (!(key in config)) {
    return defaultValue
  }

  const value = config[key]

  if (typeof value === "boolean") {
    return value
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase()
    return normalized === "true" || normalized === "yes" || normalized === "1"
  }

  return Boolean(value)
}