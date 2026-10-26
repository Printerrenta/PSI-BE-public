package lt.printerrental.migration;

import static org.assertj.core.api.Assertions.*;

import java.sql.*;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.*;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.*;

@Testcontainers
class PlatformMigrationIT {
  @Container
  static final PostgreSQLContainer<?> PG = new PostgreSQLContainer<>("postgres:17-alpine");

  @Test
  void migratesLegacyRowsAndRemovesCrossServiceForeignKeys() throws Exception {
    var legacy =
        Flyway.configure()
            .dataSource(PG.getJdbcUrl(), PG.getUsername(), PG.getPassword())
            .locations("classpath:legacy")
            .load();
    legacy.migrate();
    try (var c = DriverManager.getConnection(PG.getJdbcUrl(), PG.getUsername(), PG.getPassword());
        var s = c.createStatement()) {
      for (var schema : new String[] {"identity", "rental", "documents", "notifications"}) {
        s.execute(
            "CREATE ROLE psi_"
                + schema
                + " LOGIN PASSWORD 'test'; CREATE SCHEMA "
                + schema
                + " AUTHORIZATION psi_"
                + schema);
      }
      s.execute(
          "INSERT INTO public.app_users(subject,email,display_name,role)"
              + " VALUES('migration-user','user@test','Migration','CUSTOMER')");
      Flyway.configure()
          .dataSource(PG.getJdbcUrl(), PG.getUsername(), PG.getPassword())
          .schemas("platform")
          .locations("classpath:db/platform")
          .load()
          .migrate();
      try (var rs = s.executeQuery("SELECT subject FROM identity.app_users")) {
        assertThat(rs.next()).isTrue();
        assertThat(rs.getString(1)).isEqualTo("migration-user");
      }
      try (var rs = s.executeQuery("SELECT to_regclass('public.app_users')")) {
        rs.next();
        assertThat(rs.getString(1)).isNull();
      }
      try (var rs =
          s.executeQuery(
              "SELECT count(*) FROM pg_constraint WHERE"
                  + " conrelid='documents.contract_attachments'::regclass AND contype='f'")) {
        rs.next();
        assertThat(rs.getInt(1)).isZero();
      }
      try (var rental = DriverManager.getConnection(PG.getJdbcUrl(), "psi_rental", "test");
          var stmt = rental.createStatement()) {
        stmt.executeQuery("SELECT count(*) FROM rental.rental_requests");
        assertThatThrownBy(() -> stmt.executeQuery("SELECT * FROM identity.app_users"))
            .isInstanceOf(SQLException.class);
        assertThatThrownBy(() -> stmt.executeQuery("SELECT * FROM documents.contract_attachments"))
            .isInstanceOf(SQLException.class);
      }
    }
  }
}
