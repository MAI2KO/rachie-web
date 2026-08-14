function createBookingSpreadsheetFromTemplate(
  newName,
  stateCode,
  discordServerId,
  discordServerName,
  createdBy
) {
  const lock = LockService.getScriptLock()
  lock.waitLock(30000)

  let ss = null

  try {
    const validatedStateCode = validateStateCode_(stateCode)

    const existing = findStateInRegistry_(validatedStateCode)
    if (existing) {
      throw new Error("State " + validatedStateCode + " is already registered.")
    }

    const templateFile = DriveApp.getFileById(TEMPLATE_SHEET_ID)

    const copy = templateFile.makeCopy(
      newName || ("Minister Booking - State " + validatedStateCode)
    )

    ss = SpreadsheetApp.openById(copy.getId())

    DriveApp.getFileById(ss.getId()).setSharing(
      DriveApp.Access.ANYONE_WITH_LINK,
      DriveApp.Permission.VIEW
    )

    resetTemplateBookingData_(ss)
    ensureBotUsersTab_(ss)
    ensureBotConfigTab_(ss)

    const access = initializeStateAccess_(ss, validatedStateCode)

    registerStateInRegistry_({
      state_code: validatedStateCode,
      sheet_id: ss.getId(),
      sheet_name: ss.getName(),
      state_api_key: access.state_api_key,
      booking_url: access.booking_url,
      created_at: new Date(),
      created_by: createdBy || "",
      status: "active",
      notes: ""
    })

    linkDiscordServerToState_(
      validatedStateCode,
      discordServerId || "",
      discordServerName || "",
      createdBy || ""
    )

    rebuildRegistryDashboard_()

    return {
      spreadsheetId: ss.getId(),
      url: ss.getUrl(),
      name: ss.getName(),
      sheet_url: ss.getUrl(),
      state_api_key: access.state_api_key,
      state_code: access.state_code,
      booking_url: access.booking_url
    }

  } catch (err) {
    if (ss) {
      try {
        DriveApp.getFileById(ss.getId()).setTrashed(true)
      } catch (cleanupErr) {}
    }
    throw err

  } finally {
    lock.releaseLock()
  }
}

/* -------------------- REGISTRY -------------------- */

function refreshRegistryDashboard() {
  rebuildRegistryDashboard_()
}

/* -------------------- TEMPLATE RESET -------------------- */

function resetTemplateBookingData_(ss) {
  const sheet = ss.getSheetByName(SLOT_SHEET_NAME)

  if (!sheet) {
    throw new Error("Sheet '" + SLOT_SHEET_NAME + "' not found in template.")
  }

  const rangesToClear = [
    "B12:F59",
    "G12:J59",
    "K12:M59"
  ]

  rangesToClear.forEach(range => {
    sheet.getRange(range).clearContent()
  })
}

/* -------------------- BOT USERS -------------------- */

function ensureBotUsersTab_(ss) {
  let sh = ss.getSheetByName("bot_users")

  if (!sh) {
    sh = ss.insertSheet("bot_users")
  }

  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, 6).setValues([[
      "discordUserId",
      "discordTag",
      "gameName",
      "gameId",
      "alliance",
      "updatedAt"
    ]])
  }
}

/* -------------------- BOT CONFIG -------------------- */

function ensureBotConfigTab_(ss) {
  let sh = ss.getSheetByName("bot_config")

  if (!sh) {
    sh = ss.insertSheet("bot_config")
  }

  if (sh.getLastRow() === 0) {
    const config = [
      ["key", "value"],

      ["construction_fc_required", false],
      ["construction_rfc_required", false],
      ["construction_speedups_required", false],

      ["research_shards_required", false],
      ["research_speedups_required", false],

      ["troop_speedups_required", false],

      ["booking_open", true],
      ["allow_booking_changes", true],
      ["max_bookings_per_player_per_day", 6],
      ["max_linked_servers", 5],

      ["state_api_key", ""],
      ["state_code", ""],
      ["booking_url", ""]
    ]

    sh.getRange(1, 1, config.length, 2).setValues(config)
  }
}

/* -------------------- STATE ACCESS -------------------- */

function initializeStateAccess_(ss, stateCode) {
  const validatedStateCode = validateStateCode_(stateCode)

  let stateApiKey = String(getConfigValue_(ss, "state_api_key") || "").trim()

  if (!stateApiKey) {
    stateApiKey = generateRandomKey_(24)
    setConfigValue_(ss, "state_api_key", stateApiKey)
  }

  setConfigValue_(ss, "state_code", validatedStateCode)

  const bookingUrl =
    ScriptApp.getService().getUrl() +
    "?state=" + encodeURIComponent(validatedStateCode)

  setConfigValue_(ss, "booking_url", bookingUrl)

  return {
    state_api_key: stateApiKey,
    state_code: validatedStateCode,
    booking_url: bookingUrl
  }
}

/* -------------------- HELPERS -------------------- */

function generateRandomKey_(length) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"
  let result = ""

  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }

  return result
}