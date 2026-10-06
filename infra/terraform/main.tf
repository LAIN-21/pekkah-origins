# Worker A is the existing GPU droplet `pekkah`. It is read here and never
# created, changed or destroyed by this config. The only thing Terraform does
# with it is list its id in the worker firewall below.
data "digitalocean_droplet" "gpu" {
  name = var.gpu_droplet_name

  lifecycle {
    postcondition {
      condition     = self.ipv4_address == var.gpu_droplet_ip
      error_message = "The droplet named `${var.gpu_droplet_name}` does not have the expected IP ${var.gpu_droplet_ip}. Refusing to attach a firewall to it."
    }
  }
}

locals {
  user_data = file("${path.module}/cloud-init.yaml")
}

resource "digitalocean_droplet" "market" {
  name     = "pekkah-market"
  region   = var.region
  size     = var.market_size
  image    = var.image
  ssh_keys = var.ssh_key_ids
  tags     = [var.tag]

  user_data  = local.user_data
  monitoring = true

  lifecycle {
    # Editing cloud-init or a newer image must never replace a live droplet.
    ignore_changes = [user_data, image]
  }
}

resource "digitalocean_droplet" "worker_b" {
  name     = "pekkah-worker-b"
  region   = var.worker_b_region
  size     = var.worker_b_size
  image    = var.image
  ssh_keys = var.ssh_key_ids
  tags     = [var.tag]

  user_data  = local.user_data
  monitoring = true

  lifecycle {
    ignore_changes = [user_data, image]
  }
}

resource "digitalocean_droplet" "worker_c" {
  name     = "pekkah-worker-c"
  region   = var.region
  size     = var.worker_c_size
  image    = var.image
  ssh_keys = var.ssh_key_ids
  tags     = [var.tag]

  user_data  = local.user_data
  monitoring = true

  lifecycle {
    ignore_changes = [user_data, image]
  }
}

resource "digitalocean_reserved_ip" "market" {
  region     = var.region
  droplet_id = digitalocean_droplet.market.id
}

locals {
  # DigitalOcean firewalls drop any outbound traffic that no rule allows,
  # so both firewalls allow all outbound traffic explicitly.
  outbound_all = [
    { protocol = "tcp", port_range = "1-65535" },
    { protocol = "udp", port_range = "1-65535" },
    { protocol = "icmp", port_range = null },
  ]
  anywhere = ["0.0.0.0/0", "::/0"]
}

resource "digitalocean_firewall" "market" {
  name        = "pekkah-market"
  droplet_ids = [digitalocean_droplet.market.id]

  dynamic "inbound_rule" {
    for_each = ["22", "80", "443"]
    content {
      protocol         = "tcp"
      port_range       = inbound_rule.value
      source_addresses = local.anywhere
    }
  }

  dynamic "outbound_rule" {
    for_each = local.outbound_all
    content {
      protocol              = outbound_rule.value.protocol
      port_range            = outbound_rule.value.port_range
      destination_addresses = local.anywhere
    }
  }
}

resource "digitalocean_firewall" "workers" {
  name = "pekkah-workers"
  droplet_ids = [
    digitalocean_droplet.worker_b.id,
    digitalocean_droplet.worker_c.id,
    data.digitalocean_droplet.gpu.id,
  ]

  # Workers dial out to the market, so SSH is the only inbound port.
  inbound_rule {
    protocol         = "tcp"
    port_range       = "22"
    source_addresses = local.anywhere
  }

  dynamic "outbound_rule" {
    for_each = local.outbound_all
    content {
      protocol              = outbound_rule.value.protocol
      port_range            = outbound_rule.value.port_range
      destination_addresses = local.anywhere
    }
  }
}
