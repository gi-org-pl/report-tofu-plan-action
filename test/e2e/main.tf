resource "terraform_data" "example" {
  input = "report-tofu-plan-action"
}

output "example" {
  value = terraform_data.example.output
}
