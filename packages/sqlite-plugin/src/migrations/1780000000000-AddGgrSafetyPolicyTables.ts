import { MigrationInterface, QueryRunner } from 'typeorm'

export class AddGgrSafetyPolicyTables1780000000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ggr_safety_state (
        scope_key varchar PRIMARY KEY NOT NULL,
        state_json text NOT NULL,
        updated_at datetime NOT NULL
      )
    `)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ggr_safety_event (
        id integer PRIMARY KEY AUTOINCREMENT,
        scope_key varchar NOT NULL,
        type varchar NOT NULL,
        payload_json text NOT NULL,
        created_at datetime NOT NULL
      )
    `)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ggr_action_ledger (
        id integer PRIMARY KEY AUTOINCREMENT,
        scope_key varchar,
        action_type varchar NOT NULL,
        action_key varchar,
        status varchar NOT NULL,
        details_json text NOT NULL,
        created_at datetime NOT NULL
      )
    `)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ggr_approval_request (
        id varchar PRIMARY KEY NOT NULL,
        kind varchar NOT NULL,
        status varchar NOT NULL DEFAULT 'PENDING',
        context_json text NOT NULL,
        context_hash varchar NOT NULL,
        requested_by varchar,
        reviewer_id varchar,
        reviewer_note text,
        reviewed_at datetime,
        expires_at datetime NOT NULL,
        grant_hash varchar,
        created_at datetime NOT NULL,
        updated_at datetime NOT NULL
      )
    `)
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS ggr_company_cooldown (
        company_key varchar PRIMARY KEY NOT NULL,
        reason varchar NOT NULL,
        expires_at datetime NOT NULL,
        created_at datetime NOT NULL,
        updated_at datetime NOT NULL
      )
    `)

    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_ggr_safety_state_scope ON ggr_safety_state (scope_key)')
    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_ggr_action_ledger_type_time ON ggr_action_ledger (action_type, created_at)')
    await queryRunner.query('CREATE INDEX IF NOT EXISTS idx_ggr_approval_request_status_expiry ON ggr_approval_request (status, expires_at)')
    await queryRunner.query("CREATE UNIQUE INDEX IF NOT EXISTS uq_ggr_approval_request_pending_context ON ggr_approval_request (kind, context_hash) WHERE status = 'PENDING'")
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
