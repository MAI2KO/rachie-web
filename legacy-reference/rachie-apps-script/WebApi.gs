/* -------------------- GET -------------------- */

function doGet(e) {
  try {
    const stateCode = String(e.parameter.state || "").trim()

    if (stateCode) {
      const record = getStateRecordOrThrow_(stateCode)

      const template = HtmlService.createTemplateFromFile("booking")
      template.sheetId = String(record.sheet_id || "")
      template.webAppUrl = ScriptApp.getService().getUrl()

      return template.evaluate()
        .setTitle("Minister Booking")
        .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    }

    const action = String(e.parameter.action || "").trim()
    const sheetId = String(e.parameter.sheetId || "").trim()

    if (!sheetId) {
      return jsonResponse_({ ok: false, error: "sheetId or state is required" })
    }

    const ss = SpreadsheetApp.openById(sheetId)

    validateApiKeyForSheet_(ss, e.parameter.key)

    if (action === "times") {
      const day = String(e.parameter.day || "").trim()

      if (!day) {
        return jsonResponse_({ ok: false, error: "day is required" })
      }

      const times = getAvailableTimesForDay_(ss, day)

      return jsonResponse_({
        ok: true,
        day: day,
        times: times
      })
    }

    return jsonResponse_({ ok: false, error: "Unknown GET action" })

  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err.message || err) })
  }
}

/* -------------------- POST -------------------- */

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents || "{}")
    const action = String(body.action || "").trim()

    /* -------------------- ADMIN BOT ACTIONS -------------------- */

    if (action === "setup_state") {
      validateAdminApiKey_(body.adminKey)

      const result = createStateForDiscord_(
        body.stateCode,
        body.discordServerId,
        body.discordServerName,
        body.createdBy
      )

      return jsonResponse_(result)
    }

    if (action === "link_state") {
      validateAdminApiKey_(body.adminKey)

      const result = linkStateForDiscord_(
        body.stateCode,
        body.discordServerId,
        body.discordServerName,
        body.createdBy,
        body.joinPassword
      )

      return jsonResponse_(result)
    }

    if (action === "get_booking_config_for_server") {
      validateAdminApiKey_(body.adminKey)

      const record = getStateByServerIdOrThrow_(body.discordServerId)
      const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())
      const config = getConfig_(ss)

      return jsonResponse_({
        ok: true,
        construction_fc_required: Boolean(config.construction_fc_required),
        construction_rfc_required: Boolean(config.construction_rfc_required),
        construction_speedups_required: Boolean(config.construction_speedups_required),
        research_shards_required: Boolean(config.research_shards_required),
        research_speedups_required: Boolean(config.research_speedups_required),
        troop_speedups_required: Boolean(config.troop_speedups_required)
      })
    }

    if (action === "get_booking_link_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = getBookingLinkForDiscordServer_(body.discordServerId)
      return jsonResponse_(result)
    }

    if (action === "get_times_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = getTimesForDiscordServer_(body.discordServerId, body.day)
      return jsonResponse_(result)
    }

    if (action === "register_player_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = registerPlayerForDiscordServer_(body.discordServerId, {
        discordUserId: body.discordUserId,
        discordTag: body.discordTag,
        inGameName: body.inGameName,
        playerId: body.playerId,
        alliance: body.alliance
      })

      return jsonResponse_(result)
    }

    if (action === "get_registered_player_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = getRegisteredPlayerForDiscordServer_(
        body.discordServerId,
        body.discordUserId
      )

      return jsonResponse_(result)
    }

    if (action === "delete_registered_player_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = deleteRegisteredPlayerForDiscordServer_(
        body.discordServerId,
        body.discordUserId
      )

      return jsonResponse_(result)
    }

    if (action === "book_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = bookForDiscordServer_(
        body.discordServerId,
        body.discordUserId,
        {
          day: body.day,
          time: body.time,
          fc: body.fc,
          rfc: body.rfc,
          shards: body.shards,
          speedups: body.speedups
        }
      )

      return jsonResponse_(result)
    }

    if (action === "remove_booking_for_server") {
      validateAdminApiKey_(body.adminKey)

      const player = getRegisteredPlayerRecordForDiscordServer_(
        body.discordServerId,
        body.discordUserId
      )

      const ss = SpreadsheetApp.openById(String(player.sheet_id || "").trim())

      const result = unbookAppointmentForDay_(
        ss,
        body.day,
        player.playerId
      )

      return jsonResponse_({
        ok: true,
        state_code: player.state_code,
        ...result
      })
    }

    if (action === "get_my_bookings_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = getMyBookingsForDiscordServer_(
        body.discordServerId,
        body.discordUserId
      )

      return jsonResponse_(result)
    }

    if (action === "open_bookings_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = setBookingOpenForDiscordServer_(
        body.discordServerId,
        true
      )

      return jsonResponse_(result)
    }

    if (action === "close_bookings_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = setBookingOpenForDiscordServer_(
        body.discordServerId,
        false
      )

      return jsonResponse_(result)
    }

    if (action === "get_sheet_link_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = getSheetLinkForDiscordServer_(body.discordServerId)
      return jsonResponse_(result)
    }

    if (action === "set_announcement_channel") {
      validateAdminApiKey_(body.adminKey)

      const result = setAnnouncementChannelForServer_(
        body.discordServerId,
        body.channelId
      )

      return jsonResponse_(result)
    }

    if (action === "get_settings_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = getSettingsForDiscordServer_(body.discordServerId)
      return jsonResponse_(result)
    }

    if (action === "set_bot_admin_role_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = setBotAdminRoleForDiscordServer_(
        body.discordServerId,
        body.roleId
      )

      return jsonResponse_(result)
    }

    if (action === "clear_bot_admin_role_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = clearBotAdminRoleForDiscordServer_(body.discordServerId)
      return jsonResponse_(result)
    }

    if (action === "set_banter_channel_for_server") {
  validateAdminApiKey_(body.adminKey)

  const result = setBanterChannelForDiscordServer_(
    body.discordServerId,
    body.channelId
  )

  return jsonResponse_(result)
}

if (action === "clear_banter_channel_for_server") {
  validateAdminApiKey_(body.adminKey)

  const result = clearBanterChannelForDiscordServer_(body.discordServerId)
  return jsonResponse_(result)
}

if (action === "get_banter_channel_for_server") {
  validateAdminApiKey_(body.adminKey)

  const result = getBanterChannelForDiscordServer_(body.discordServerId)
  return jsonResponse_(result)
}

    if (action === "get_bot_admin_role_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = getBotAdminRoleForDiscordServer_(body.discordServerId)
      return jsonResponse_(result)
    }

    if (action === "update_setting_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = updateSettingForDiscordServer_(
        body.discordServerId,
        body.key,
        body.value
      )

      return jsonResponse_(result)
    }

    if (action === "set_banter_spice_for_server") {
  validateAdminApiKey_(body.adminKey)

  const result = setBanterSpiceForDiscordServer_(
    body.discordServerId,
    body.spiceLevel
  )

  return jsonResponse_(result)
}

if (action === "get_banter_spice_for_server") {
  validateAdminApiKey_(body.adminKey)

  const result = getBanterSpiceForDiscordServer_(body.discordServerId)
  return jsonResponse_(result)
}

    if (action === "unlink_state_server") {
      validateAdminApiKey_(body.adminKey)

      const result = removeDiscordLinkFromState_(
        body.stateCode,
        body.discordServerName
      )

      rebuildRegistryDashboard_()
      return jsonResponse_(result)
    }

    if (action === "get_linked_servers_for_current_state") {
      validateAdminApiKey_(body.adminKey)

      const result = getLinkedDiscordServersForStateByServerId_(body.discordServerId)
      return jsonResponse_(result)
    }

    if (action === "unlink_state_server_by_id") {
      validateAdminApiKey_(body.adminKey)

      const result = unlinkDiscordServerById_(body.targetDiscordServerId)
      return jsonResponse_(result)
    }

    if (action === "reset_state_password") {
      validateAdminApiKey_(body.adminKey)

      const result = resetStateJoinPasswordForDiscordServer_(body.discordServerId)
      return jsonResponse_(result)
    }

    if (action === "admin_add_booking_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = adminAddBookingForDiscordServer_(
        body.discordServerId,
        {
          day: body.day,
          time: body.time,
          alliance: body.alliance,
          inGameName: body.inGameName,
          playerId: body.playerId
        }
      )

      return jsonResponse_(result)
    }

    if (action === "clear_bookings_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = clearBookingsForDiscordServer_(body.discordServerId)
      return jsonResponse_(result)
    }

    if (action === "grant_sheet_access_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = grantSheetAccessForDiscordServer_(
        body.discordServerId,
        body.email
      )

      return jsonResponse_(result)
    }

    if (action === "admin_remove_booking_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = adminRemoveBookingForDiscordServer_(
        body.discordServerId,
        body.playerId,
        body.day
      )

      return jsonResponse_(result)
    }

    if (action === "admin_reserve_slots_for_server") {
      validateAdminApiKey_(body.adminKey)

      const result = adminReserveSlotsForDiscordServer_(
        body.discordServerId,
        body.day,
        body.times || []
      )

      return jsonResponse_(result)
    }

    if (action === "get_reserved_times_for_server") {
  validateAdminApiKey_(body.adminKey)

  const record = getStateByServerIdOrThrow_(body.discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  const result = {
    ok: true,
    state_code: record.state_code,
    day: body.day,
    times: getReservedTimesForDay_(ss, body.day)
  }

  return jsonResponse_(result)
}

if (action === "admin_remove_reserved_slots_for_server") {
  validateAdminApiKey_(body.adminKey)

  const result = adminRemoveReservedSlotsForDiscordServer_(
    body.discordServerId,
    body.day,
    body.times || []
  )

  return jsonResponse_(result)
}

if (action === "get_booking_date_for_server") {
  validateAdminApiKey_(body.adminKey)

  const result = getBookingDateForDiscordServer_(
    body.discordServerId,
    body.day
  )

  return jsonResponse_(result)
}

if (action === "set_booking_date_for_server") {
  validateAdminApiKey_(body.adminKey)

  const result = setBookingDateForDiscordServer_(
    body.discordServerId,
    body.day,
    body.date
  )

  return jsonResponse_(result)
}

    /* -------------------- PUBLIC API ACTIONS -------------------- */

    const sheetId = String(body.sheetId || "").trim()

    if (!sheetId) {
      return jsonResponse_({ ok: false, error: "sheetId is required" })
    }

    const ss = SpreadsheetApp.openById(sheetId)

    validateApiKeyForSheet_(ss, body.key)

    if (action === "book") {
      const result = bookAppointmentForDay_(ss, body.day, {
        alliance: body.alliance,
        inGameName: body.inGameName,
        playerId: body.playerId,
        time: body.time,
        fc: body.fc,
        rfc: body.rfc,
        shards: body.shards,
        speedups: body.speedups
      })

      return jsonResponse_(result)
    }

    if (action === "unbook") {
      const result = unbookAppointmentForDay_(ss, body.day, body.playerId)
      return jsonResponse_(result)
    }

    if (action === "register") {
      const result = registerPlayer_(ss, {
        discordUserId: body.discordUserId,
        discordTag: body.discordTag,
        inGameName: body.inGameName,
        playerId: body.playerId,
        alliance: body.alliance
      })

      return jsonResponse_(result)
    }

    return jsonResponse_({ ok: false, error: "Unknown POST action" })

  } catch (err) {
    return jsonResponse_({ ok: false, error: String(err.message || err) })
  }
}

/* -------------------- SHARED HELPERS -------------------- */

function validateApiKeyForSheet_(ss, key) {
  const providedKey = String(key || "").trim()
  const expectedKey = String(getConfigValue_(ss, "state_api_key") || "").trim()

  if (!providedKey || !expectedKey || providedKey !== expectedKey) {
    throw new Error("Unauthorized")
  }
}

function jsonResponse_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON)
}

/* -------------------- BOT USERS -------------------- */

function registerPlayer_(ss, player) {
  const sh = ss.getSheetByName("bot_users")

  if (!sh) {
    throw new Error("bot_users sheet not found")
  }

  const discordUserId = String(player.discordUserId || "").trim()
  const discordTag = String(player.discordTag || "").trim()
  const inGameName = String(player.inGameName || "").trim()
  const playerId = String(player.playerId || "").trim()
  const alliance = String(player.alliance || "").trim()

  if (!discordUserId) throw new Error("discordUserId is required")
  if (!inGameName) throw new Error("inGameName is required")
  if (!playerId) throw new Error("playerId is required")

  const rows = sh.getDataRange().getValues()
  let foundRow = null

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim() === discordUserId) {
      foundRow = i + 1
      break
    }
  }

  const values = [
    discordUserId,
    discordTag,
    inGameName,
    playerId,
    alliance,
    new Date()
  ]

  if (foundRow) {
    throw new Error("You are already registered. Delete your current registration before registering again.")
  }

  sh.appendRow(values)

  return {
    ok: true,
    registered: true,
    discordUserId: discordUserId,
    inGameName: inGameName,
    playerId: playerId,
    alliance: alliance
  }
}

/* -------------------- WEB HELPERS -------------------- */

function webGetBookingConfig(sheetId) {
  const ss = SpreadsheetApp.openById(String(sheetId || "").trim())
  const config = getConfig_(ss)

  return {
    ok: true,
    construction_fc_required: Boolean(config.construction_fc_required),
    construction_rfc_required: Boolean(config.construction_rfc_required),
    construction_speedups_required: Boolean(config.construction_speedups_required),
    research_shards_required: Boolean(config.research_shards_required),
    research_speedups_required: Boolean(config.research_speedups_required),
    troop_speedups_required: Boolean(config.troop_speedups_required)
  }
}

function webBookMultiple(payload) {
  const ss = SpreadsheetApp.openById(String(payload.sheetId || "").trim())
  return bookMultipleAppointments_(ss, payload)
}

function webGetAvailableTimes(sheetId, day) {
  const ss = SpreadsheetApp.openById(String(sheetId || "").trim())

  return {
    ok: true,
    day: day,
    times: getAvailableTimesForDay_(ss, day)
  }
}

function webBook(payload) {
  const ss = SpreadsheetApp.openById(String(payload.sheetId || "").trim())

  return bookAppointmentForDay_(ss, payload.day, {
    alliance: payload.alliance,
    inGameName: payload.inGameName,
    playerId: payload.playerId,
    time: payload.time,
    fc: payload.fc,
    rfc: payload.rfc,
    shards: payload.shards,
    speedups: payload.speedups
  })
}

/* -------------------- SHEET LINK -------------------- */

function getSheetLinkForDiscordServer_(discordServerId) {
  const record = getStateByServerIdOrThrow_(discordServerId)

  return {
    ok: true,
    state_code: record.state_code,
    sheet_id: record.sheet_id,
    sheet_name: record.sheet_name,
    sheet_url: "https://docs.google.com/spreadsheets/d/" + record.sheet_id,
    booking_url: record.booking_url
  }
}