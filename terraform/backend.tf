terraform {
  backend "s3" {
    bucket         = "regional-health-tfstate-glory"
    key            = "terraform.tfstate"
    dynamodb_table = "terraform-locks"
    region         = "eu-west-3"

    # LocalStack endpoints (tflocal handles this automatically, but explicit
    # for clarity / real-AWS portability -- remove these overrides for prod).
    skip_credentials_validation = true
    skip_metadata_api_check     = true
    skip_region_validation      = true
    use_path_style              = true
  }
}
