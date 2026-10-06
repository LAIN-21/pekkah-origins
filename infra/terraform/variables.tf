variable "region" {
  description = "Region for the market and the CPU workers."
  type        = string
  default     = "tor1"
}

variable "ssh_key_ids" {
  description = "DigitalOcean SSH key ids allowed on the new droplets."
  type        = list(number)
  default     = [59840566]
}

variable "image" {
  description = "Base image for the new droplets."
  type        = string
  default     = "ubuntu-24-04-x64"
}

variable "tag" {
  description = "Tag on every droplet this config creates."
  type        = string
  default     = "pekkah-demo"
}

variable "market_size" {
  type    = string
  default = "s-2vcpu-4gb"

  validation {
    condition     = !startswith(var.market_size, "gpu-")
    error_message = "GPU sizes are forbidden here. The only GPU droplet is the existing `pekkah`, which this config never creates or changes."
  }
}

variable "worker_b_size" {
  type    = string
  default = "s-8vcpu-16gb-amd"

  validation {
    condition     = !startswith(var.worker_b_size, "gpu-")
    error_message = "GPU sizes are forbidden here. The only GPU droplet is the existing `pekkah`, which this config never creates or changes."
  }
}

variable "worker_b_region" {
  description = "8 vCPU basic droplets are not offered in tor1, so worker B can live elsewhere. Workers dial out to the market, so the region only adds a little latency."
  type        = string
  default     = "nyc3"
}

variable "worker_c_size" {
  type    = string
  default = "s-2vcpu-2gb"

  validation {
    condition     = !startswith(var.worker_c_size, "gpu-")
    error_message = "GPU sizes are forbidden here. The only GPU droplet is the existing `pekkah`, which this config never creates or changes."
  }
}

variable "gpu_droplet_name" {
  description = "The existing GPU droplet (worker A). Read only; Terraform only attaches the worker firewall to it."
  type        = string
  default     = "pekkah"
}

variable "gpu_droplet_ip" {
  description = "Expected public IP of the GPU droplet, checked so the firewall can't land on a different droplet with the same name."
  type        = string
  default     = "159.203.0.34"
}
