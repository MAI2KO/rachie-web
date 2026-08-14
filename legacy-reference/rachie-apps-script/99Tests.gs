function testCreateStateSheet() {
  const result = createBookingSpreadsheetFromTemplate(
    "Test State 9996 Booking Sheet",
    "9996",
    "test-server",
    "Test Server",
    "Mark"
  );

  Logger.log(JSON.stringify(result, null, 2));
}