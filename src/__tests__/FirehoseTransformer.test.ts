import { GraphQLTransform } from "graphql-transformer-core";
import { DynamoDBModelTransformer } from "graphql-dynamodb-transformer";
import FirehoseTransformer from "../index";

// @ts-ignore
import { AppSyncTransformer } from "graphql-appsync-transformer";

const transformer = new GraphQLTransform({
  transformers: [
    new AppSyncTransformer(),
    new DynamoDBModelTransformer(),
    new FirehoseTransformer(),
  ],
});

test("@firehose directive can be used on types", () => {
  const schema = `
    type Todo @model @firehose(name: "auditlog") {
      id: ID!
      title: String!
      description: String
    }
  `;
  expect(() => transformer.transform(schema)).not.toThrow();
});

test("@firehose directive can not be used on fields", () => {
  const schema = `
    type ExpiringChatMessage @model {
      id: ID!
      title: String!
      description: String @firehose(name: "auditlog")
    }
  `;
  expect(() => transformer.transform(schema)).toThrowError(
    'Directive "firehose" may not be used on FIELD_DEFINITION.'
  );
});

test("@firehose directive must be used together with @model directive", () => {
  const schema = `
      type Todo @firehose(name: "auditlog") {
        id: ID!
        title: String!
        description: String
      }
    `;
  expect(() => transformer.transform(schema)).toThrowError(
    "Types annotated with @firehose must also be annotated with @model."
  );
});

test("@firehose directive must contain a name argument", () => {
  const schema = `
      type Todo @firehose {
        id: ID!
        title: String!
        description: String
      }
    `;
  expect(() => transformer.transform(schema)).toThrowError(
    'Directive "@firehose" argument "name" of type "String!" is required, but it was not provided.'
  );
});

test("Transformer can be executed without errors", () => {
  const schema = `
    type Todo @model @firehose(name: "auditlog") {
        id: ID!
        title: String!
        description: String
    }
  `;
  transformer.transform(schema);
});
