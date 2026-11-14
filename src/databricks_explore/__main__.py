"""`python -m databricks_explore` does what the `databricks-explore` command does."""
import sys

from .cli import main

sys.exit(main())
