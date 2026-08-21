output "secret_arn" {
  value = module.data.secret_arn
}
output "instance_id" {
  value = module.service.instance_id
}
output "public_ip" {
  value = module.service.public_ip
}
output "nginx_port" {
  value = module.service.nginx_port
}
