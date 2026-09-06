// This file sets up the connection to the local Neo4j graph database.
// Everything that reads from or writes to the graph (the ETL step, and
// eventually search) goes through the "driver" object this file creates.
//
// Neo4j docs for the JS driver: https://neo4j.com/docs/javascript-manual/current/

import neo4j, { type Driver } from 'neo4j-driver';
import { getEnvVar, getRequiredEnvVar } from '../env.ts';

const NEO4J_URI = getEnvVar('NEO4J_URI', 'bolt://localhost:7687');
const NEO4J_USERNAME = getEnvVar('NEO4J_USERNAME', 'neo4j');
const NEO4J_PASSWORD = getRequiredEnvVar('NEO4J_PASSWORD');

/**
 * Creates a Neo4j "driver" -- an object that manages a pool of connections
 * to the database. You typically create ONE driver for your whole
 * application (not one per query) and reuse it; the driver handles
 * connection pooling and retries internally.
 */
export function createNeo4jDriver(): Driver {
  return neo4j.driver(NEO4J_URI, neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD));
}
