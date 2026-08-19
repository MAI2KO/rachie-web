export const POSTGRES_DATE_OID = 1082;

export function configurePostgresTypeParsers(postgresTypes) {
  postgresTypes.setTypeParser(POSTGRES_DATE_OID, (value) => value);
}
