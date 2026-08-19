export const RATE_LIMIT_POLICIES = Object.freeze({
  oauthLogin: Object.freeze({ code: "oauth_login", limit: 10, windowSeconds: 600 }),
  oauthCallback: Object.freeze({
    code: "oauth_callback",
    limit: 20,
    windowSeconds: 600,
  }),
  authSessionRead: Object.freeze({
    code: "auth_session_read",
    limit: 120,
    windowSeconds: 60,
  }),
  communityChange: Object.freeze({
    code: "community_change",
    limit: 10,
    windowSeconds: 600,
  }),
  logout: Object.freeze({ code: "logout", limit: 10, windowSeconds: 600 }),
  bookingRead: Object.freeze({
    code: "booking_read",
    limit: 120,
    windowSeconds: 60,
  }),
  futureBookingMutation: Object.freeze({
    code: "future_booking_mutation",
    limit: 10,
    windowSeconds: 60,
  }),
});
