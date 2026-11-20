package lt.printerrental.migration;

import java.net.URI;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import org.flywaydb.core.Flyway;

/** Operator-only migration. Never runs inside an HTTP service. Stop legacy writes first. */
public final class PlatformMigration {
  public static void main(String[] args) {
    if (!"true".equals(System.getenv("CONFIRM_LEGACY_WRITES_STOPPED")))
      throw new IllegalStateException(
          "Set CONFIRM_LEGACY_WRITES_STOPPED=true after stopping legacy writes");
    var rawDatabaseUrl = System.getenv("DATABASE_URL_UNPOOLED");
    if (rawDatabaseUrl == null || rawDatabaseUrl.isBlank())
      throw new IllegalArgumentException(
          "DATABASE_URL_UNPOOLED must be set to a direct PostgreSQL URL with credentials");
    var uri = URI.create(rawDatabaseUrl.trim());
    var rawUserInfo = uri.getRawUserInfo();
    if (rawUserInfo == null || rawUserInfo.isBlank())
      throw new IllegalArgumentException(
          "DATABASE_URL_UNPOOLED must include username and password credentials");
    var credentials = rawUserInfo.split(":", 2);
    if (credentials.length < 2 || credentials[0].isBlank())
      throw new IllegalArgumentException(
          "DATABASE_URL_UNPOOLED must include both username and password in user:password format");
    if (uri.getHost() == null
        || uri.getHost().isBlank()
        || uri.getRawPath() == null
        || uri.getRawPath().isBlank())
      throw new IllegalArgumentException(
          "DATABASE_URL_UNPOOLED must include a valid host and database path");
    var url =
        "jdbc:postgresql://"
            + uri.getHost()
            + (uri.getPort() < 0 ? "" : ":" + uri.getPort())
            + uri.getRawPath()
            + "?sslmode=verify-full&sslfactory=org.postgresql.ssl.DefaultJavaSSLFactory";
    Flyway.configure()
        .dataSource(url, decode(credentials[0]), decode(credentials[1]))
        .schemas("platform")
        .locations("classpath:db/platform")
        .load()
        .migrate();
  }

  private static String decode(String value) {
    return URLDecoder.decode(value.replace("+", "%2B"), StandardCharsets.UTF_8);
  }
}
