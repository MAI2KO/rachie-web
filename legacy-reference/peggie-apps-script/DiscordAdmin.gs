/* -------------------- SECURITY -------------------- */

function validateAdminApiKey_(key) {
  const providedKey = String(key || "").trim()
  const expectedKey = String(ADMIN_API_KEY || "").trim()

  if (!providedKey || providedKey !== expectedKey) {
    throw new Error("Unauthorized")
  }
}

/* -------------------- STATE SETUP -------------------- */

function createStateForDiscord_(stateCode, discordServerId, discordServerName, createdBy) {
  const validatedStateCode = validateStateCode_(stateCode)
  const serverId = String(discordServerId || "").trim()
  const serverName = String(discordServerName || "").trim()
  const creator = String(createdBy || "").trim()

  if (!serverId) {
    throw new Error("discordServerId is required.")
  }

  const existingServerLink = findDiscordLinkByServerId_(serverId)
  if (existingServerLink) {
    throw new Error(
      "This Discord server is already linked to state " + existingServerLink.state_code + "."
    )
  }

  const existingState = findStateInRegistry_(validatedStateCode)
  if (existingState) {
    throw new Error(
      "State " + validatedStateCode + " already exists. Use link-state instead."
    )
  }

  const created = createBookingSpreadsheetFromTemplate(
    "",
    validatedStateCode,
    serverId,
    serverName,
    creator
  )

  const createdState = getStateRecordOrThrow_(validatedStateCode)

  rebuildRegistryDashboard_()

  return {
    ok: true,
    created: true,
    state_code: created.state_code,
    booking_url: created.booking_url,
    sheet_id: created.spreadsheetId,
    sheet_name: created.name,
    sheet_url: created.sheet_url,
    join_password: createdState.join_password || ""
  }
}

/* -------------------- LINK STATE -------------------- */

function linkStateForDiscord_(stateCode, discordServerId, discordServerName, createdBy, joinPassword) {
  const validatedStateCode = validateStateCode_(stateCode)
  const serverId = String(discordServerId || "").trim()
  const serverName = String(discordServerName || "").trim()
  const creator = String(createdBy || "").trim()
  const providedPassword = String(joinPassword || "").trim()

  if (!serverId) {
    throw new Error("discordServerId is required.")
  }

  const existingServerLink = findDiscordLinkByServerId_(serverId)

  if (existingServerLink) {
    if (String(existingServerLink.state_code || "").trim() !== validatedStateCode) {
      throw new Error(
        "This Discord server is already linked to state " + existingServerLink.state_code + "."
      )
    }

    const existingLinkedState = getStateRecordOrThrow_(existingServerLink.state_code)

    return {
      ok: true,
      linked: true,
      existed: true,
      already_linked: true,
      state_code: existingLinkedState.state_code,
      booking_url: existingLinkedState.booking_url,
      sheet_id: existingLinkedState.sheet_id,
      sheet_name: existingLinkedState.sheet_name,
      sheet_url: "https://docs.google.com/spreadsheets/d/" + existingLinkedState.sheet_id
    }
  }

  const existingState = findStateInRegistry_(validatedStateCode)

  if (!existingState) {
    throw new Error(
      "State " + validatedStateCode + " does not exist. Use setup first."
    )
  }

  const ss = SpreadsheetApp.openById(String(existingState.sheet_id || "").trim())
  const config = getConfig_(ss)
  const maxLinkedServers = Number(config.max_linked_servers || 5)

  const currentLinks = getLinkedDiscordServersForState_(validatedStateCode)

  if (currentLinks.length >= maxLinkedServers) {
    throw new Error(
      "State " + validatedStateCode +
      " has reached the maximum number of linked Discord servers (" +
      maxLinkedServers + ")."
    )
  }

  verifyStateJoinPassword_(validatedStateCode, providedPassword)

  const newLink = linkDiscordServerToState_(
    validatedStateCode,
    serverId,
    serverName,
    creator
  )

  rebuildRegistryDashboard_()

  return {
    ok: true,
    linked: true,
    existed: true,
    already_linked: false,
    state_code: existingState.state_code,
    booking_url: existingState.booking_url,
    sheet_id: existingState.sheet_id,
    sheet_name: existingState.sheet_name,
    sheet_url: "https://docs.google.com/spreadsheets/d/" + existingState.sheet_id,
    discord_server_id: newLink.discord_server_id,
    discord_server_name: newLink.discord_server_name
  }
}

/* -------------------- BASIC FETCH -------------------- */

function getBookingLinkForDiscordServer_(discordServerId) {
  const record = getStateByServerIdOrThrow_(discordServerId)

  return {
    ok: true,
    state_code: record.state_code,
    booking_url: record.booking_url,
    sheet_name: record.sheet_name
  }
}

function getTimesForDiscordServer_(discordServerId, day) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  return {
    ok: true,
    state_code: record.state_code,
    day: day,
    times: getAvailableTimesForDay_(ss, day)
  }
}

function getBookingDateForDiscordServer_(discordServerId, day) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  const result = getBookingDateForDay_(ss, day)

  return {
    ok: true,
    state_code: record.state_code,
    day: day,
    iso_date: result.iso_date || "",
    display_date: result.display_date || ""
  }
}

/* -------------------- PLAYER -------------------- */

function registerPlayerForDiscordServer_(discordServerId, player) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  const result = registerPlayer_(ss, {
    discordUserId: player.discordUserId,
    discordTag: player.discordTag,
    inGameName: player.inGameName,
    playerId: player.playerId,
    alliance: player.alliance
  })

  return {
    ok: true,
    state_code: record.state_code,
    ...result
  }
}

function getRegisteredPlayerForDiscordServer_(discordServerId, discordUserId) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  const sh = ss.getSheetByName("bot_users")
  if (!sh) throw new Error("bot_users sheet not found")

  const rows = sh.getDataRange().getValues()
  const wantedUserId = String(discordUserId || "").trim()

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim() === wantedUserId) {
      return {
        ok: true,
        state_code: record.state_code,
        found: true,
        discordUserId: rows[i][0] || "",
        discordTag: rows[i][1] || "",
        inGameName: rows[i][2] || "",
        playerId: rows[i][3] || "",
        alliance: rows[i][4] || ""
      }
    }
  }

  return {
    ok: true,
    state_code: record.state_code,
    found: false
  }
}

function getRegisteredPlayerRecordForDiscordServer_(discordServerId, discordUserId) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  const sh = ss.getSheetByName("bot_users")
  if (!sh) throw new Error("bot_users sheet not found")

  const rows = sh.getDataRange().getValues()
  const wantedUserId = String(discordUserId || "").trim()

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim() === wantedUserId) {
      return {
        state_code: record.state_code,
        sheet_id: record.sheet_id,
        discordUserId: rows[i][0] || "",
        discordTag: rows[i][1] || "",
        inGameName: rows[i][2] || "",
        playerId: rows[i][3] || "",
        alliance: rows[i][4] || ""
      }
    }
  }

  throw new Error("No registered player details found. Use /register first.")
}

/* -------------------- BOOKINGS -------------------- */

function bookForDiscordServer_(discordServerId, discordUserId, booking) {
  const player = getRegisteredPlayerRecordForDiscordServer_(discordServerId, discordUserId)
  const ss = SpreadsheetApp.openById(String(player.sheet_id || "").trim())

  const result = bookAppointmentForDay_(ss, booking.day, {
    alliance: player.alliance,
    inGameName: player.inGameName,
    playerId: player.playerId,
    time: booking.time,
    fc: booking.fc,
    rfc: booking.rfc,
    shards: booking.shards,
    speedups: booking.speedups
  })

  const bookingDate = getBookingDateForDay_(ss, booking.day)

  return {
    ok: true,
    state_code: player.state_code,
    playerName: buildPlayerDisplayName_(player.alliance, player.inGameName),
    playerId: player.playerId,
    booking_date_iso: bookingDate.iso_date || "",
    booking_date_display: bookingDate.display_date || "",
    ...result
  }
}

function getMyBookingsForDiscordServer_(discordServerId, discordUserId) {
  const player = getRegisteredPlayerRecordForDiscordServer_(discordServerId, discordUserId)
  const ss = SpreadsheetApp.openById(String(player.sheet_id || "").trim())
  const sheet = ss.getSheetByName(SLOT_SHEET_NAME)

  if (!sheet) {
    throw new Error("Sheet '" + SLOT_SHEET_NAME + "' not found")
  }

  const times = sheet.getRange(TIME_RANGE).getDisplayValues()

  function findBookingForDay_(day) {
    const map = getDayMap_(day)
    const idValues = sheet.getRange(12, map.idCol, times.length).getValues()

    for (let i = 0; i < idValues.length; i++) {
      if (String(idValues[i][0] || "").trim() === String(player.playerId).trim()) {
        return String(times[i][0] || "").trim()
      }
    }

    return ""
  }

  return {
    ok: true,
    state_code: player.state_code,
    playerName: buildPlayerDisplayName_(player.alliance, player.inGameName),
    playerId: player.playerId,
    dates: {
      Construction: getBookingDateForDay_(ss, "Construction").display_date || "",
      Research: getBookingDateForDay_(ss, "Research").display_date || "",
      Troop: getBookingDateForDay_(ss, "Troop").display_date || ""
    },
    bookings: {
      Construction: findBookingForDay_("Construction"),
      Research: findBookingForDay_("Research"),
      Troop: findBookingForDay_("Troop")
    }
  }
}

function getBookingDateForDiscordServer_(discordServerId, day) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  const result = getBookingDateForDay_(ss, day)

  return {
    ok: true,
    state_code: record.state_code,
    ...result
  }
}

function setBookingDateForDiscordServer_(discordServerId, day, isoDate) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  const result = setBookingDateForDay_(ss, day, isoDate)

  return {
    ok: true,
    state_code: record.state_code,
    ...result
  }
}

/* -------------------- DELETE / SETTINGS -------------------- */

function deleteRegisteredPlayerForDiscordServer_(discordServerId, discordUserId) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  const sh = ss.getSheetByName("bot_users")
  if (!sh) throw new Error("bot_users sheet not found")

  const rows = sh.getDataRange().getValues()
  const wantedUserId = String(discordUserId || "").trim()

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim() === wantedUserId) {
      sh.deleteRow(i + 1)

      return {
        ok: true,
        state_code: record.state_code,
        deleted: true
      }
    }
  }

  return {
    ok: true,
    state_code: record.state_code,
    deleted: false
  }
}

function setBookingOpenForDiscordServer_(discordServerId, isOpen) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  setConfigValue_(ss, "booking_open", Boolean(isOpen))

  return {
    ok: true,
    state_code: record.state_code,
    booking_open: Boolean(isOpen)
  }
}

function getSettingsForDiscordServer_(discordServerId) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())
  const config = getConfig_(ss)

  return {
    ok: true,
    state_code: record.state_code,
    sheet_name: record.sheet_name,
    settings: {
      booking_open: getBooleanConfig_(config, "booking_open", true),
      allow_booking_changes: getBooleanConfig_(config, "allow_booking_changes", true),
      max_bookings_per_player_per_day: String(config.max_bookings_per_player_per_day || "1"),
      max_linked_servers: String(config.max_linked_servers || "5"),

      construction_fc_required: getBooleanConfig_(config, "construction_fc_required", false),
      construction_rfc_required: getBooleanConfig_(config, "construction_rfc_required", false),
      construction_speedups_required: getBooleanConfig_(config, "construction_speedups_required", false),

      research_shards_required: getBooleanConfig_(config, "research_shards_required", false),
      research_speedups_required: getBooleanConfig_(config, "research_speedups_required", false),

      troop_speedups_required: getBooleanConfig_(config, "troop_speedups_required", false)
    }
  }
}

function setBanterChannelForDiscordServer_(discordServerId, channelId) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  const cleanChannelId = String(channelId || "").trim()
  if (!cleanChannelId) {
    throw new Error("channelId is required.")
  }

  setConfigValue_(ss, "banter_channel_id", cleanChannelId)

  return {
    ok: true,
    state_code: record.state_code,
    banter_channel_id: cleanChannelId
  }
}

function clearBanterChannelForDiscordServer_(discordServerId) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  setConfigValue_(ss, "banter_channel_id", "")

  return {
    ok: true,
    state_code: record.state_code,
    banter_channel_id: ""
  }
}

function getBanterChannelForDiscordServer_(discordServerId) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())
  const config = getConfig_(ss)

  return {
    ok: true,
    state_code: record.state_code,
    banter_channel_id: String(config.banter_channel_id || "").trim()
  }
}

function setBanterSpiceForDiscordServer_(discordServerId, spiceLevel) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  const cleanLevel = String(spiceLevel || "").trim().toLowerCase()

  if (["mild", "standard", "spicy"].indexOf(cleanLevel) === -1) {
    throw new Error("Invalid spice level. Use mild, standard, or spicy.")
  }

  setConfigValue_(ss, "banter_spice_level", cleanLevel)

  return {
    ok: true,
    state_code: record.state_code,
    banter_spice_level: cleanLevel
  }
}

function getBanterSpiceForDiscordServer_(discordServerId) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())
  const config = getConfig_(ss)

  return {
    ok: true,
    state_code: record.state_code,
    banter_spice_level: String(config.banter_spice_level || "standard").trim().toLowerCase() || "standard"
  }
}

function setBotAdminRoleForDiscordServer_(discordServerId, roleId) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  const cleanRoleId = String(roleId || "").trim()
  if (!cleanRoleId) {
    throw new Error("roleId is required.")
  }

  setConfigValue_(ss, "bot_admin_role_id", cleanRoleId)

  return {
    ok: true,
    state_code: record.state_code,
    bot_admin_role_id: cleanRoleId
  }
}

function clearBotAdminRoleForDiscordServer_(discordServerId) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  setConfigValue_(ss, "bot_admin_role_id", "")

  return {
    ok: true,
    state_code: record.state_code,
    bot_admin_role_id: ""
  }
}

function getBotAdminRoleForDiscordServer_(discordServerId) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())
  const config = getConfig_(ss)

  return {
    ok: true,
    state_code: record.state_code,
    bot_admin_role_id: String(config.bot_admin_role_id || "").trim()
  }
}

function updateSettingForDiscordServer_(discordServerId, key, value) {
  const allowedBooleanKeys = {
    booking_open: true,
    allow_booking_changes: true,
    construction_fc_required: true,
    construction_rfc_required: true,
    construction_speedups_required: true,
    research_shards_required: true,
    research_speedups_required: true,
    troop_speedups_required: true
  }

  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  if (key === "max_bookings_per_player_per_day") {
    const raw = String(value || "").trim()

    if (!/^(6|9|12|15|18)$/.test(raw)) {
      throw new Error("Max bookings per player per day must be 6, 9, 12, 15 or 18.")
    }

    setConfigValue_(ss, key, Number(raw))

    return {
      ok: true,
      state_code: record.state_code,
      key: key,
      value: Number(raw)
    }
  }

  if (key === "max_linked_servers") {
    const raw = String(value || "").trim()

    if (!/^(5|10|15|20)$/.test(raw)) {
      throw new Error("Max linked servers must be 5, 10, 15 or 20.")
    }

    setConfigValue_(ss, key, Number(raw))

    return {
      ok: true,
      state_code: record.state_code,
      key: key,
      value: Number(raw)
    }
  }

  if (!allowedBooleanKeys[key]) {
    throw new Error("That setting cannot be changed from Discord.")
  }

  const boolValue =
    String(value).trim().toLowerCase() === "true" ||
    String(value).trim() === "1" ||
    value === true

  setConfigValue_(ss, key, boolValue)

  return {
    ok: true,
    state_code: record.state_code,
    key: key,
    value: boolValue
  }
}