/* -------------------- MAIN BOOKING -------------------- */

function bookAppointmentForDay_(ss, day, booking) {
  const sheet = ss.getSheetByName(SLOT_SHEET_NAME)
  if (!sheet) {
    throw new Error("Sheet '" + SLOT_SHEET_NAME + "' not found")
  }

  const config = getConfig_(ss)

  if (!getBooleanConfig_(config, "booking_open", true)) {
    throw new Error("Bookings are currently closed for this state.")
  }

  const isAdmin = Boolean(booking.isAdmin)
  const isReservedBooking =
  isAdmin &&
  String(booking.playerId || "").trim() === "RESERVED" &&
  String(booking.inGameName || "").trim().toUpperCase() === "RESERVED";
  const map = getDayMap_(day)
  const time = String(booking.time || "").trim()

  if (!isReservedBooking) {
  validatePlayerIdentity_(
    booking.alliance,
    booking.inGameName,
    booking.playerId
  );
}

 const playerName = isReservedBooking
  ? "RESERVED"
  : buildPlayerDisplayName_(
      booking.alliance,
      booking.inGameName
    );
  const playerId = String(booking.playerId || "").trim()

  if (!time) {
    throw new Error("Time is required.")
  }

  if (!playerName) {
    throw new Error("Player name is required.")
  }

  if (!playerId) {
    throw new Error("Player ID is required.")
  }

  validateExtrasForDay_(day, booking, config)

  const times = sheet.getRange(TIME_RANGE).getDisplayValues()
  const normalizedRequestedTime = normalizeTime_(time)

  let targetRow = null

  for (let i = 0; i < times.length; i++) {
    const normalizedSheetTime = normalizeTime_(times[i][0] || "")
    if (normalizedSheetTime === normalizedRequestedTime) {
      targetRow = i + 12
      break
    }
  }

  if (!targetRow) {
    throw new Error("Time slot '" + time + "' not found.")
  }

  const existingPlayerId = String(
    sheet.getRange(targetRow, map.idCol).getValue() || ""
  ).trim()

  if (existingPlayerId === "RESERVED" && !isAdmin) {
    throw new Error("This slot is reserved and cannot be booked.")
  }

  const idValues = sheet.getRange(12, map.idCol, times.length).getValues()
  let oldRow = null

if (!isReservedBooking) {
  for (let i = 0; i < idValues.length; i++) {
    if (String(idValues[i][0] || "").trim() === playerId) {
      oldRow = i + 12
      break
    }
  }
}

  if (oldRow && oldRow === targetRow) {
    throw new Error("You already have this time slot booked.")
  }

  const existingIdAtTarget = String(sheet.getRange(targetRow, map.idCol).getValue() || "").trim()

  if (existingIdAtTarget && existingIdAtTarget !== playerId) {
   const adminOverwritingReserved = isAdmin && existingIdAtTarget === "RESERVED"

    if (!adminOverwritingReserved) {
      throw new Error("That time slot is already booked by another player.")
    }
  }

  const allowBookingChanges = getBooleanConfig_(config, "allow_booking_changes", true)

  if (oldRow && oldRow !== targetRow && !allowBookingChanges) {
    throw new Error("Changing an existing booking is not allowed.")
  }

  if (oldRow && oldRow !== targetRow) {
    sheet.getRange(oldRow, map.startCol, 1, map.width).clearContent()
  }

  sheet.getRange(targetRow, map.nameCol).setValue(playerName)
  sheet.getRange(targetRow, map.idCol).setValue(playerId)

  if (day === "Construction") {
    sheet.getRange(targetRow, 4).setValue(booking.fc || "")
    sheet.getRange(targetRow, 5).setValue(booking.rfc || "")
    sheet.getRange(targetRow, 6).setValue(formatSpeedupsForSheet_(booking.speedups))
  }

  if (day === "Research") {
    sheet.getRange(targetRow, 9).setValue(booking.shards || "")
    sheet.getRange(targetRow, 10).setValue(formatSpeedupsForSheet_(booking.speedups))
  }

  if (day === "Troop") {
    sheet.getRange(targetRow, 13).setValue(formatSpeedupsForSheet_(booking.speedups))
  }

  return {
    ok: true,
    day: day,
    time: time,
    moved: Boolean(oldRow && oldRow !== targetRow),
    oldTime: oldRow && oldRow !== targetRow
      ? String(times[oldRow - 12][0] || "").trim()
      : null,
    row: targetRow
  }
}

function unbookAppointmentForDay_(ss, day, playerId) {
  const sheet = ss.getSheetByName(SLOT_SHEET_NAME)
  if (!sheet) {
    throw new Error("Sheet '" + SLOT_SHEET_NAME + "' not found")
  }

  const map = getDayMap_(day)
  const times = sheet.getRange(TIME_RANGE).getDisplayValues()
  const idValues = sheet.getRange(12, map.idCol, times.length).getValues()

  for (let i = 0; i < idValues.length; i++) {
    const currentPlayerId = String(idValues[i][0] || "").trim()

    if (currentPlayerId === String(playerId).trim()) {
      if (currentPlayerId === "RESERVED") {
        throw new Error("This slot is reserved and cannot be removed.")
      }

      const row = i + 12
      const oldTime = String(times[i][0] || "").trim()

      sheet.getRange(row, map.startCol, 1, map.width).clearContent()

      return {
        ok: true,
        removed: true,
        day: day,
        oldTime: oldTime,
        row: row
      }
    }
  }

  return {
    ok: true,
    removed: false,
    day: day
  }
}

/* -------------------- ADMIN BOOKING -------------------- */

function adminAddBookingForDiscordServer_(discordServerId, booking) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  const day = String(booking.day || "").trim()
  const time = String(booking.time || "").trim()
  const alliance = String(booking.alliance || "").trim().toUpperCase()
  const inGameName = String(booking.inGameName || "").trim()
  const playerId = String(booking.playerId || "").trim()

  if (!day) {
    throw new Error("Day is required.")
  }

  if (!time) {
    throw new Error("Time is required.")
  }

  if (!/^[A-Z0-9]{3}$/.test(alliance)) {
    throw new Error("Alliance tag must be exactly 3 letters or numbers.")
  }

  if (!inGameName) {
    throw new Error("Player name is required.")
  }

  if (!/^[0-9]+$/.test(playerId)) {
    throw new Error("Player ID must contain numbers only.")
  }

  const result = bookAppointmentForDay_(ss, day, {
  alliance: "",
  inGameName: "RESERVED",
  playerId: "RESERVED",
  time: time,
  fc: "",
  rfc: "",
  shards: "",
  speedups: "",
  isAdmin: true
});

  return {
    ok: true,
    state_code: record.state_code,
    day: day,
    time: result.time || time,
    alliance: alliance,
    playerName: inGameName,
    playerId: playerId,
    moved: Boolean(result.moved),
    oldTime: result.oldTime || ""
  }
}

function adminReserveSlotsForDiscordServer_(discordServerId, day, times) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())

  const cleanDay = String(day || "").trim()
  const cleanTimes = (times || []).map(t => String(t || "").trim()).filter(Boolean)

  if (!cleanDay) {
    throw new Error("Day is required.")
  }

  if (!cleanTimes.length) {
    throw new Error("At least one time is required.")
  }

  const success = []
  const failed = []

  for (const time of cleanTimes) {
    try {
      const result = bookAppointmentForDay_(ss, cleanDay, {
        alliance: "",
        inGameName: "RESERVED",
        playerId: "RESERVED",
        time: time,
        fc: "",
        rfc: "",
        shards: "",
        speedups: "",
        isAdmin: true
      })

      success.push(result.time || time)

    } catch (err) {
      failed.push({
        time: time,
        error: String(err.message || err)
      })
    }
  }

  return {
    ok: true,
    state_code: record.state_code,
    day: cleanDay,
    count: success.length,
    times: success,
    failed: failed
  }
}

function getReservedTimesForDay_(ss, day) {
  const sheet = ss.getSheetByName(SLOT_SHEET_NAME)
  if (!sheet) {
    throw new Error("Sheet '" + SLOT_SHEET_NAME + "' not found")
  }

  const map = getDayMap_(day)
  const times = sheet.getRange(TIME_RANGE).getDisplayValues()
  const idValues = sheet.getRange(12, map.idCol, times.length).getValues()

  const reserved = []

  for (let i = 0; i < times.length; i++) {
    const id = String(idValues[i][0] || "").trim()
    const time = String(times[i][0] || "").trim()

    if (id === "RESERVED") {
      reserved.push(time)
    }
  }

  return reserved
}

function adminRemoveReservedSlotsForDiscordServer_(discordServerId, day, times) {
  const record = getStateByServerIdOrThrow_(discordServerId)
  const ss = SpreadsheetApp.openById(String(record.sheet_id || "").trim())
  const sheet = ss.getSheetByName(SLOT_SHEET_NAME)

  if (!sheet) {
    throw new Error("Sheet '" + SLOT_SHEET_NAME + "' not found")
  }

  const cleanDay = String(day || "").trim()
  const cleanTimes = (times || []).map(t => String(t || "").trim()).filter(Boolean)

  if (!cleanDay) {
    throw new Error("Day is required.")
  }

  if (!cleanTimes.length) {
    throw new Error("At least one time is required.")
  }

  const map = getDayMap_(cleanDay)
  const allTimes = sheet.getRange(TIME_RANGE).getDisplayValues()

  const removed = []
  const failed = []

  for (const wantedTime of cleanTimes) {
    const normalizedWantedTime = normalizeTime_(wantedTime)
    let targetRow = null

    for (let i = 0; i < allTimes.length; i++) {
      const normalizedSheetTime = normalizeTime_(allTimes[i][0] || "")
      if (normalizedSheetTime === normalizedWantedTime) {
        targetRow = i + 12
        break
      }
    }

    if (!targetRow) {
      failed.push({
        time: wantedTime,
        error: "Time slot not found."
      })
      continue
    }

    const existingId = String(sheet.getRange(targetRow, map.idCol).getValue() || "").trim()

    if (existingId !== "RESERVED") {
      failed.push({
        time: wantedTime,
        error: "That slot is not reserved."
      })
      continue
    }

    sheet.getRange(targetRow, map.startCol, 1, map.width).clearContent()
    removed.push(wantedTime)
  }

  return {
    ok: true,
    state_code: record.state_code,
    day: cleanDay,
    count: removed.length,
    times: removed,
    failed: failed
  }
}

function getDayDateCellA1_(day) {
  if (day === "Construction") return "B7"
  if (day === "Research") return "G7"
  if (day === "Troop") return "K7"

  throw new Error("Unknown day: " + day)
}

function parseIsoDateAsUtcParts_(value) {
  const raw = String(value || "").trim()

  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new Error("Date must be in YYYY-MM-DD format.")
  }

  const parts = raw.split("-")
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])

  const test = new Date(Date.UTC(year, month - 1, day))

  if (
    test.getUTCFullYear() !== year ||
    test.getUTCMonth() !== month - 1 ||
    test.getUTCDate() !== day
  ) {
    throw new Error("Invalid date.")
  }

  return {
    year: year,
    month: month,
    day: day
  }
}

function formatUtcDateToIso_(dateValue) {
  const d = new Date(dateValue)

  if (isNaN(d.getTime())) {
    return ""
  }

  const year = d.getUTCFullYear()
  const month = String(d.getUTCMonth() + 1).padStart(2, "0")
  const day = String(d.getUTCDate()).padStart(2, "0")

  return year + "-" + month + "-" + day
}

function getBookingDateForDay_(ss, day) {
  const sheet = ss.getSheetByName(SLOT_SHEET_NAME)
  if (!sheet) {
    throw new Error("Sheet '" + SLOT_SHEET_NAME + "' not found")
  }

  const cellA1 = getDayDateCellA1_(day)
  const range = sheet.getRange(cellA1)

  const rawValue = range.getValue()
  const displayValue = String(range.getDisplayValue() || "").trim()

  if (!rawValue) {
    return {
      ok: true,
      day: day,
      cell: cellA1,
      iso_date: "",
      display_date: displayValue
    }
  }

  return {
    ok: true,
    day: day,
    cell: cellA1,
    iso_date: formatUtcDateToIso_(rawValue),
    display_date: displayValue
  }
}

function setBookingDateForDay_(ss, day, isoDate) {
  const sheet = ss.getSheetByName(SLOT_SHEET_NAME)
  if (!sheet) {
    throw new Error("Sheet '" + SLOT_SHEET_NAME + "' not found")
  }

  const cellA1 = getDayDateCellA1_(day)
  const parsed = parseIsoDateAsUtcParts_(isoDate)

  const dateForSheet = new Date(parsed.year, parsed.month - 1, parsed.day)

  Logger.log("setBookingDateForDay_")
  Logger.log("Day: " + day)
  Logger.log("Cell: " + cellA1)
  Logger.log("Sheet name: " + sheet.getName())
  Logger.log("ISO input: " + isoDate)
  Logger.log("Date object: " + dateForSheet)

  const range = sheet.getRange(cellA1)
  range.setValue(dateForSheet)
  range.setNumberFormat("d mmmm yyyy")

  SpreadsheetApp.flush()

  Logger.log("Display after write: " + range.getDisplayValue())
  Logger.log("Raw after write: " + range.getValue())

  return getBookingDateForDay_(ss, day)
}


/* -------------------- BULK WEB BOOKING -------------------- */

function bookMultipleAppointments_(ss, payload) {
  const results = []
  const playerId = String(payload.playerId || "").trim()

  const constructionTime = String(payload.constructionTime || "").trim()
  if (constructionTime) {
    try {
      if (constructionTime === REMOVE_BOOKING_VALUE) {
        const result = unbookAppointmentForDay_(ss, "Construction", playerId)

        results.push({
          day: "Construction",
          ok: true,
          removed: result.removed || false,
          oldTime: result.oldTime || null
        })
      } else {
        const result = bookAppointmentForDay_(ss, "Construction", {
          alliance: payload.alliance,
          inGameName: payload.inGameName,
          playerId: payload.playerId,
          time: constructionTime,
          fc: payload.fc,
          rfc: payload.rfc,
          speedups: payload.constructionSpeedups
        })

        results.push({
          day: "Construction",
          ok: true,
          moved: result.moved || false,
          oldTime: result.oldTime || null,
          time: result.time
        })
      }
    } catch (err) {
      results.push({
        day: "Construction",
        ok: false,
        error: String(err.message || err)
      })
    }
  }

  const researchTime = String(payload.researchTime || "").trim()
  if (researchTime) {
    try {
      if (researchTime === REMOVE_BOOKING_VALUE) {
        const result = unbookAppointmentForDay_(ss, "Research", playerId)

        results.push({
          day: "Research",
          ok: true,
          removed: result.removed || false,
          oldTime: result.oldTime || null
        })
      } else {
        const result = bookAppointmentForDay_(ss, "Research", {
          alliance: payload.alliance,
          inGameName: payload.inGameName,
          playerId: payload.playerId,
          time: researchTime,
          shards: payload.shards,
          speedups: payload.researchSpeedups
        })

        results.push({
          day: "Research",
          ok: true,
          moved: result.moved || false,
          oldTime: result.oldTime || null,
          time: result.time
        })
      }
    } catch (err) {
      results.push({
        day: "Research",
        ok: false,
        error: String(err.message || err)
      })
    }
  }

  const troopTime = String(payload.troopTime || "").trim()
  if (troopTime) {
    try {
      if (troopTime === REMOVE_BOOKING_VALUE) {
        const result = unbookAppointmentForDay_(ss, "Troop", playerId)

        results.push({
          day: "Troop",
          ok: true,
          removed: result.removed || false,
          oldTime: result.oldTime || null
        })
      } else {
        const result = bookAppointmentForDay_(ss, "Troop", {
          alliance: payload.alliance,
          inGameName: payload.inGameName,
          playerId: payload.playerId,
          time: troopTime,
          speedups: payload.troopSpeedups
        })

        results.push({
          day: "Troop",
          ok: true,
          moved: result.moved || false,
          oldTime: result.oldTime || null,
          time: result.time
        })
      }
    } catch (err) {
      results.push({
        day: "Troop",
        ok: false,
        error: String(err.message || err)
      })
    }
  }

  return {
    ok: true,
    results: results
  }
}

/* -------------------- DISPLAY + VALIDATION -------------------- */

function buildPlayerDisplayName_(alliance, inGameName) {
  const tag = String(alliance || "").trim()
  const name = String(inGameName || "").trim()

  if (!name) {
    throw new Error("In-Game Name is required.")
  }

  if (!tag) {
    return name
  }

  return "[" + tag + "]" + name
}

function validatePlayerIdentity_(alliance, inGameName, playerId) {
  const tag = String(alliance || "").trim()
  const name = String(inGameName || "").trim()
  const id = String(playerId || "").trim()

  if (!name) {
    throw new Error("In-Game Name is required.")
  }

  if (!id) {
    throw new Error("Player ID is required.")
  }

  if (tag && !/^[A-Za-z0-9]{1,3}$/.test(tag)) {
    throw new Error("Alliance Tag must be 1 to 3 letters or numbers.")
  }

  if (!/^[0-9]+$/.test(id)) {
    throw new Error("Player ID must contain numbers only.")
  }
}

function validateExtrasForDay_(day, booking, config) {
  if (day === "Construction") {
    if (config.construction_fc_required && !String(booking.fc || "").trim()) {
      throw new Error("Fire Crystals are required for Construction.")
    }
    if (config.construction_rfc_required && !String(booking.rfc || "").trim()) {
      throw new Error("Refined Fire Crystals are required for Construction.")
    }
    if (config.construction_speedups_required && !String(booking.speedups || "").trim()) {
      throw new Error("Speed-ups are required for Construction.")
    }
  }

  if (day === "Research") {
    if (config.research_shards_required && !String(booking.shards || "").trim()) {
      throw new Error("Shards are required for Research.")
    }
    if (config.research_speedups_required && !String(booking.speedups || "").trim()) {
      throw new Error("Speed-ups are required for Research.")
    }
  }

  if (day === "Troop") {
    if (config.troop_speedups_required && !String(booking.speedups || "").trim()) {
      throw new Error("Speed-ups are required for Troop.")
    }
  }
}

/* -------------------- DAY MAPS + TIMES -------------------- */

function getDayMap_(day) {
  if (day === "Construction") {
    return {
      startCol: 2,
      width: 5,
      nameCol: 2,
      idCol: 3
    }
  }

  if (day === "Research") {
    return {
      startCol: 7,
      width: 4,
      nameCol: 7,
      idCol: 8
    }
  }

  if (day === "Troop") {
    return {
      startCol: 11,
      width: 3,
      nameCol: 11,
      idCol: 12
    }
  }

  throw new Error("Unknown day: " + day)
}

function normalizeTime_(value) {
  const raw = String(value || "").trim()
  if (!raw) return ""

  const parts = raw.split(":")
  if (parts.length !== 2) return raw

  const hours = String(parseInt(parts[0], 10))
  const minutes = String(parseInt(parts[1], 10)).padStart(2, "0")

  return hours + ":" + minutes
}

function getAvailableTimesForDay_(ss, day) {
  const sheet = ss.getSheetByName(SLOT_SHEET_NAME)
  if (!sheet) {
    throw new Error("Sheet '" + SLOT_SHEET_NAME + "' not found")
  }

  const map = getDayMap_(day)
  const times = sheet.getRange(TIME_RANGE).getDisplayValues()
  const idValues = sheet.getRange(12, map.idCol, times.length).getValues()

  const available = []

  for (let i = 0; i < times.length; i++) {
    const id = String(idValues[i][0] || "").trim()
    const time = String(times[i][0] || "").trim()

    if (!id) {
      available.push(time)
    }
  }

  return available
}

/* -------------------- FORMATTERS -------------------- */

function formatSpeedupsForSheet_(value) {
  const raw = String(value || "").trim()

  if (!raw) {
    return ""
  }

  if (!/^[0-9]{1,6}$/.test(raw)) {
    throw new Error("Speed-ups must be a whole number of days.")
  }

  return raw + "Days"
}