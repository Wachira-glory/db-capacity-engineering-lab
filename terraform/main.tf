# =============================================================================
# Root module -- composes the group-owned modules/data and modules/service
# from the regional-health-platform repo into one deployable stack.
# =============================================================================

module "data" {
  source = "../../regional-health-platform/modules/data"

  db_host     = var.db_host
  db_port     = var.db_port
  db_username = var.db_username
  db_password = var.db_password
  db_name     = var.db_name
}

module "service" {
  source     = "../../regional-health-platform/modules/service"
  secret_arn = module.data.secret_arn
}
