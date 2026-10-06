terraform {
  required_version = ">= 1.6"

  required_providers {
    digitalocean = {
      source  = "digitalocean/digitalocean"
      version = "~> 2.0"
    }
  }

  # State lives outside the repo, in ~/.pekkah/terraform.tfstate.
  # scripts/tf.sh passes the path with -backend-config.
  backend "local" {}
}

# The token comes from DIGITALOCEAN_TOKEN in the environment.
provider "digitalocean" {}
