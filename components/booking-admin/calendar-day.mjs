const EVENT_MARKERS = Object.freeze({
  construction: Object.freeze({ icon: "hammer", label: "Construction" }),
  research: Object.freeze({ icon: "flask", label: "Research" }),
  troop: Object.freeze({ icon: "helmet", label: "Troop Training" }),
});

/**
 * @param {string} date UTC date in YYYY-MM-DD form
 * @param {string} openDate UTC opening date
 * @param {string} closeDate UTC closing date
 * @param {readonly { date: string, serviceCode: string, serviceName: string }[]} appointments
 */
export function bookingCalendarDay(date, openDate, closeDate, appointments) {
  return Object.freeze({
    isOpen: date === openDate,
    isClose: date === closeDate,
    inRange: date > openDate && date < closeDate,
    events: Object.freeze(appointments.filter((appointment) => appointment.date === date)
      .map((appointment) => Object.freeze({
        serviceCode: appointment.serviceCode,
        icon: EVENT_MARKERS[appointment.serviceCode]?.icon ?? "dot",
        label: EVENT_MARKERS[appointment.serviceCode]?.label ?? appointment.serviceName,
      }))),
  });
}
