output "market_ip" {
  description = "The market droplet's own public IP (SSH)."
  value       = digitalocean_droplet.market.ipv4_address
}

output "market_reserved_ip" {
  description = "The reserved IP on the market (PUBLIC_HOST, PUBLIC_URL)."
  value       = digitalocean_reserved_ip.market.ip_address
}

output "worker_a_ip" {
  description = "The existing GPU droplet `pekkah`."
  value       = data.digitalocean_droplet.gpu.ipv4_address
}

output "worker_b_ip" {
  value = digitalocean_droplet.worker_b.ipv4_address
}

output "worker_c_ip" {
  value = digitalocean_droplet.worker_c.ipv4_address
}

output "droplet_ids" {
  value = {
    market = digitalocean_droplet.market.id
    a      = data.digitalocean_droplet.gpu.id
    b      = digitalocean_droplet.worker_b.id
    c      = digitalocean_droplet.worker_c.id
  }
}
