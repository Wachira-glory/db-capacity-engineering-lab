variable "db_host" {
  type = string
}
variable "db_port" {
  type    = number
  default = 3306
}
variable "db_username" {
  type    = string
  default = "avnadmin"
}
variable "db_password" {
  type      = string
  sensitive = true
}
variable "db_name" {
  type    = string
  default = "capacity_lab"
}
