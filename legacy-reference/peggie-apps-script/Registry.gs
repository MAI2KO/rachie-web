const DISCORD_LINKS_SHEET_NAME = "state_discord_links"

/* -------------------- VALIDATION -------------------- */

function validateStateCode_(stateCode) {
  const code = String(stateCode || "").trim()

  if (!code) {
    throw new Error("State number is required.")
  }

  if (!/^[0-9]+$/.test(code)) {
    throw new Error("State number must contain numbers only.")
  }

  return code
}

function generateJoinPassword_(length) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789"
  let result = ""

  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length))
  }

  return result
}

/* -------------------- SHEETS -------------------- */

function getRegistrySheet_() {
  const ss = SpreadsheetApp.openById(REGISTRY_SPREADSHEET_ID)
  const sh = ss.getSheetByName(REGISTRY_SHEET_NAME)

  if (!sh) {
    throw new Error("Registry sheet '" + REGISTRY_SHEET_NAME + "' not found.")
  }

  return sh
}

function getDiscordLinksSheet_() {
  const ss = SpreadsheetApp.openById(REGISTRY_SPREADSHEET_ID)
  let sh = ss.getSheetByName(DISCORD_LINKS_SHEET_NAME)

  if (!sh) {
    sh = ss.insertSheet(DISCORD_LINKS_SHEET_NAME)
    sh.getRange(1, 1, 1, 8).setValues([[
      "state_code",
      "discord_server_id",
      "discord_server_name",
      "linked_at",
      "linked_by",
      "status",
      "notes",
      "announcement_channel_id"
    ]])
  } else {
    const headers = sh.getRange(1, 1, 1, Math.max(1, sh.getLastColumn())).getValues()[0]

    if (headers.indexOf("announcement_channel_id") === -1) {
      sh.getRange(1, 8).setValue("announcement_channel_id")
    }
  }

  return sh
}

/* -------------------- STATE REGISTRY -------------------- */

function findStateInRegistry_(stateCode) {
  const code = validateStateCode_(stateCode)
  const sh = getRegistrySheet_()
  const rows = sh.getDataRange().getValues()

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim() === code) {
      return {
        row: i + 1,
        state_code: rows[i][0],
        sheet_id: rows[i][1],
        sheet_name: rows[i][2],
        state_api_key: rows[i][3],
        booking_url: rows[i][4],
        join_password: rows[i][5],
        created_at: rows[i][6],
        created_by: rows[i][7],
        status: rows[i][8],
        notes: rows[i][9]
      }
    }
  }

  return null
}

function registerStateInRegistry_(data) {
  const sh = getRegistrySheet_()

  const existing = findStateInRegistry_(data.state_code)
  if (existing) {
    throw new Error("State " + data.state_code + " is already registered.")
  }

  sh.appendRow([
    data.state_code || "",
    data.sheet_id || "",
    data.sheet_name || "",
    data.state_api_key || "",
    data.booking_url || "",
    data.join_password || generateJoinPassword_(16),
    data.created_at || new Date(),
    data.created_by || "",
    data.status || "active",
    data.notes || ""
  ])
}

function getStateRecordOrThrow_(stateCode) {
  const record = findStateInRegistry_(stateCode)

  if (!record) {
    throw new Error("State " + stateCode + " is not registered.")
  }

  if (String(record.status || "").trim().toLowerCase() !== "active") {
    throw new Error("State " + stateCode + " is not active.")
  }

  return record
}

function updateRegistryRow_(rowNumber, updates) {
  const sh = getRegistrySheet_()

  if (updates.sheet_id !== undefined) sh.getRange(rowNumber, 2).setValue(updates.sheet_id)
  if (updates.sheet_name !== undefined) sh.getRange(rowNumber, 3).setValue(updates.sheet_name)
  if (updates.state_api_key !== undefined) sh.getRange(rowNumber, 4).setValue(updates.state_api_key)
  if (updates.booking_url !== undefined) sh.getRange(rowNumber, 5).setValue(updates.booking_url)
  if (updates.join_password !== undefined) sh.getRange(rowNumber, 6).setValue(updates.join_password)
  if (updates.status !== undefined) sh.getRange(rowNumber, 9).setValue(updates.status)
  if (updates.notes !== undefined) sh.getRange(rowNumber, 10).setValue(updates.notes)
}

function deleteStateRecord_(stateCode) {
  const record = findStateInRegistry_(stateCode)

  if (!record) {
    return { ok: true, deleted: false }
  }

  try {
    if (record.sheet_id) {
      DriveApp.getFileById(String(record.sheet_id)).setTrashed(true)
    }
  } catch (err) {}

  const sh = getRegistrySheet_()
  sh.deleteRow(record.row)

  return {
    ok: true,
    deleted: true,
    state_code: stateCode
  }
}

function verifyStateJoinPassword_(stateCode, password) {
  const record = getStateRecordOrThrow_(stateCode)
  const provided = String(password || "").trim()
  const expected = String(record.join_password || "").trim()

  if (!provided || !expected || provided !== expected) {
    throw new Error("Invalid state join password.")
  }

  return true
}

function resetStateJoinPasswordForDiscordServer_(discordServerId) {
  const state = getStateByServerIdOrThrow_(discordServerId)
  const newPassword = generateJoinPassword_(16)

  updateRegistryRow_(state.row, {
    join_password: newPassword
  })

  return {
    ok: true,
    state_code: state.state_code,
    join_password: newPassword
  }
}

/* -------------------- DISCORD LINKS -------------------- */

function findDiscordLinkByServerId_(discordServerId) {
  const serverId = String(discordServerId || "").trim()

  if (!serverId) {
    return null
  }

  const sh = getDiscordLinksSheet_()
  const rows = sh.getDataRange().getValues()

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1] || "").trim() === serverId) {
      return {
        row: i + 1,
        state_code: rows[i][0],
        discord_server_id: rows[i][1],
        discord_server_name: rows[i][2],
        linked_at: rows[i][3],
        linked_by: rows[i][4],
        status: rows[i][5],
        notes: rows[i][6],
        announcement_channel_id: rows[i][7]
      }
    }
  }

  return null
}

function findDiscordLinkForState_(stateCode, discordServerId) {
  const code = validateStateCode_(stateCode)
  const serverId = String(discordServerId || "").trim()

  const sh = getDiscordLinksSheet_()
  const rows = sh.getDataRange().getValues()

  for (let i = 1; i < rows.length; i++) {
    if (
      String(rows[i][0] || "").trim() === code &&
      String(rows[i][1] || "").trim() === serverId
    ) {
      return {
        row: i + 1,
        state_code: rows[i][0],
        discord_server_id: rows[i][1],
        discord_server_name: rows[i][2],
        linked_at: rows[i][3],
        linked_by: rows[i][4],
        status: rows[i][5],
        notes: rows[i][6]
      }
    }
  }

  return null
}

function linkDiscordServerToState_(stateCode, discordServerId, discordServerName, linkedBy) {
  const code = validateStateCode_(stateCode)
  const serverId = String(discordServerId || "").trim()

  if (!serverId) {
    throw new Error("discordServerId is required.")
  }

  const existingServerLink = findDiscordLinkByServerId_(serverId)
  if (existingServerLink) {
    if (String(existingServerLink.state_code || "").trim() !== code) {
      throw new Error(
        "This Discord server is already linked to state " + existingServerLink.state_code + "."
      )
    }

    return existingServerLink
  }

  getStateRecordOrThrow_(code)

  const sh = getDiscordLinksSheet_()
  sh.appendRow([
    code,
    serverId,
    discordServerName || "",
    new Date(),
    linkedBy || "",
    "active",
    ""
  ])

  return findDiscordLinkByServerId_(serverId)
}

function setAnnouncementChannelForServer_(discordServerId, channelId) {
  const serverId = String(discordServerId || "").trim()
  const announcementChannelId = String(channelId || "").trim()

  if (!serverId) {
    throw new Error("discordServerId is required.")
  }

  if (!announcementChannelId) {
    throw new Error("channelId is required.")
  }

  const sh = getDiscordLinksSheet_()
  const rows = sh.getDataRange().getValues()

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][1] || "").trim() === serverId) {
      sh.getRange(i + 1, 8).setValue(announcementChannelId)

      return {
        ok: true,
        discord_server_id: serverId,
        announcement_channel_id: announcementChannelId
      }
    }
  }

  throw new Error("Discord server link not found.")
}

function getStateByServerIdOrThrow_(discordServerId) {
  const link = findDiscordLinkByServerId_(discordServerId)

  if (!link) {
    throw new Error("This Discord server is not linked to a state yet.")
  }

  if (String(link.status || "").trim().toLowerCase() !== "active") {
    throw new Error("This Discord server link is not active.")
  }

  const record = getStateRecordOrThrow_(link.state_code)

  return {
    row: record.row,
    state_code: record.state_code,
    sheet_id: record.sheet_id,
    sheet_name: record.sheet_name,
    state_api_key: record.state_api_key,
    booking_url: record.booking_url,
    join_password: record.join_password,
    created_at: record.created_at,
    created_by: record.created_by,
    status: record.status,
    notes: record.notes
  }
}

function getLinkedDiscordServersForState_(stateCode) {
  const code = validateStateCode_(stateCode)
  const sh = getDiscordLinksSheet_()
  const rows = sh.getDataRange().getValues()

  const links = []

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim() === code) {
      links.push({
        state_code: rows[i][0] || "",
        discord_server_id: rows[i][1] || "",
        discord_server_name: rows[i][2] || "",
        linked_at: rows[i][3] || "",
        linked_by: rows[i][4] || "",
        status: rows[i][5] || "",
        notes: rows[i][6] || ""
      })
    }
  }

  return links
}

function getLinkedDiscordServersForStateByServerId_(discordServerId) {
  const currentState = getStateByServerIdOrThrow_(discordServerId)
  const sh = getDiscordLinksSheet_()
  const rows = sh.getDataRange().getValues()
  const stateCode = String(currentState.state_code || "").trim()

  const links = []

  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0] || "").trim() === stateCode) {
      links.push({
        state_code: rows[i][0] || "",
        discord_server_id: rows[i][1] || "",
        discord_server_name: rows[i][2] || "",
        linked_at: rows[i][3] || "",
        linked_by: rows[i][4] || "",
        status: rows[i][5] || "",
        notes: rows[i][6] || "",
        announcement_channel_id: rows[i][7] || ""
      })
    }
  }

  return {
    ok: true,
    state_code: stateCode,
    links: links
  }
}

function removeDiscordLinkFromState_(stateCode, serverName) {
  const code = validateStateCode_(stateCode)
  const wantedName = String(serverName || "").trim().toLowerCase()

  if (!wantedName) {
    throw new Error("Server name is required.")
  }

  const sh = getDiscordLinksSheet_()
  const rows = sh.getDataRange().getValues()

  for (let i = 1; i < rows.length; i++) {
    const rowStateCode = String(rows[i][0] || "").trim()
    const rowServerName = String(rows[i][2] || "").trim().toLowerCase()

    if (rowStateCode === code && rowServerName === wantedName) {
      sh.deleteRow(i + 1)

      return {
        ok: true,
        removed: true,
        state_code: code,
        discord_server_name: rows[i][2] || "",
        discord_server_id: rows[i][1] || ""
      }
    }
  }

  return {
    ok: true,
    removed: false,
    state_code: code
  }
}

function removeAllDiscordLinksForState_(stateCode) {
  const code = validateStateCode_(stateCode)
  const sh = getDiscordLinksSheet_()
  const rows = sh.getDataRange().getValues()

  for (let i = rows.length - 1; i >= 1; i--) {
    if (String(rows[i][0] || "").trim() === code) {
      sh.deleteRow(i + 1)
    }
  }
}

function unlinkDiscordServerById_(discordServerIdToRemove) {
  const serverId = String(discordServerIdToRemove || "").trim()

  if (!serverId) {
    throw new Error("discordServerId is required.")
  }

  const link = findDiscordLinkByServerId_(serverId)

  if (!link) {
    return {
      ok: true,
      removed: false
    }
  }

  const stateCode = String(link.state_code || "").trim()

  const sh = getDiscordLinksSheet_()
  sh.deleteRow(link.row)

  const remainingLinks = getLinkedDiscordServersForState_(stateCode)

  let stateDeleted = false

  if (remainingLinks.length === 0) {
    removeAllDiscordLinksForState_(stateCode)
    deleteStateRecord_(stateCode)
    stateDeleted = true
  }

  rebuildRegistryDashboard_()

  return {
    ok: true,
    removed: true,
    state_code: stateCode,
    discord_server_id: link.discord_server_id,
    discord_server_name: link.discord_server_name,
    state_deleted: stateDeleted
  }
}

/* -------------------- DASHBOARD -------------------- */

function rebuildRegistryDashboard_() {
  const ss = SpreadsheetApp.openById(REGISTRY_SPREADSHEET_ID)

  let sh = ss.getSheetByName("dashboard")
  if (!sh) {
    sh = ss.insertSheet("dashboard")
  }

  sh.clear()

  const registry = getRegistrySheet_().getDataRange().getValues()
  const links = getDiscordLinksSheet_().getDataRange().getValues()

  const output = [[
    "State",
    "Status",
    "Sheet Name",
    "Linked Discord Servers",
    "Booking URL",
    "Created At",
    "Created By"
  ]]

  for (let i = 1; i < registry.length; i++) {
    const stateCode = String(registry[i][0] || "").trim()
    const linkedServers = []

    for (let j = 1; j < links.length; j++) {
      if (String(links[j][0] || "").trim() === stateCode) {
        linkedServers.push(String(links[j][2] || links[j][1] || "").trim())
      }
    }

    output.push([
      registry[i][0] || "",
      registry[i][8] || "",
      registry[i][2] || "",
      linkedServers.join(", "),
      registry[i][4] || "",
      registry[i][6] || "",
      registry[i][7] || ""
    ])
  }

  sh.getRange(1, 1, output.length, output[0].length).setValues(output)
  sh.setFrozenRows(1)
  sh.autoResizeColumns(1, output[0].length)
}

/* -------------------- SHEET ACCESS -------------------- */

function grantSheetAccessForDiscordServer_(discordServerId, email) {
  const record = getStateByServerIdOrThrow_(discordServerId)

  const sheetId = String(record.sheet_id || "").trim()
  if (!sheetId) {
    throw new Error("Sheet ID not found.")
  }

  const cleanEmail = String(email || "").trim()

  if (!cleanEmail || !cleanEmail.includes("@")) {
    throw new Error("A valid email is required.")
  }

  const file = DriveApp.getFileById(sheetId)
  file.addEditor(cleanEmail)

  return {
    ok: true,
    state_code: record.state_code,
    email: cleanEmail
  }
}

/* -------------------- ADMIN BOOKING ACTIONS -------------------- */

function clearBookingsForDiscordServer_(discordServerId) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())
  const sheet = ss.getSheetByName(SLOT_SHEET_NAME)

  if (!sheet) {
    throw new Error("Slot sheet not found.")
  }

  const rangesToClear = [
    "B12:F59",
    "G12:J59",
    "K12:M59"
  ]

  rangesToClear.forEach(range => {
    sheet.getRange(range).clearContent()
  })

  return {
    ok: true,
    state_code: record.state_code,
    cleared: true
  }
}

function adminRemoveBookingForDiscordServer_(discordServerId, playerId, day) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  const targetPlayerId = String(playerId || "").trim()
  const targetDay = String(day || "").trim()

  if (!targetPlayerId) {
    throw new Error("Player ID is required.")
  }

  if (!targetDay) {
    throw new Error("Day is required.")
  }

  if (targetDay === "ALL") {
    const days = ["Construction", "Research", "Troop"]
    let removedCount = 0

    days.forEach(dayName => {
      const result = unbookAppointmentForDay_(ss, dayName, targetPlayerId)
      if (result && result.removed) {
        removedCount++
      }
    })

    return {
      ok: true,
      state_code: record.state_code,
      removed: removedCount > 0,
      removed_count: removedCount
    }
  }

  const result = unbookAppointmentForDay_(ss, targetDay, targetPlayerId)

  return {
    ok: true,
    state_code: record.state_code,
    removed: Boolean(result && result.removed),
    removed_count: result && result.removed ? 1 : 0,
    ...result
  }
}
