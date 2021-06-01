import {
  Transformer,
  gql,
  TransformerContext,
  InvalidDirectiveError,
  getDirectiveArguments,
} from "graphql-transformer-core";
import {
  obj,
  str,
  ref,
  printBlock,
  compoundExpression,
  qref,
  raw,
  iff,
} from "graphql-mapping-template";
import { AppSync, Fn, IAM } from "cloudform-types";
import { DirectiveNode, ObjectTypeDefinitionNode } from "graphql";
import {
  FunctionResourceIDs,
  plurality,
  ResolverResourceIDs,
  ResourceConstants,
} from "graphql-transformer-common";

const FIREHOSE_DIRECTIVE_STACK = "FirehoseDirectiveStack";
const DYNAMODB_METADATA_KEY = "DynamoDBTransformerMetadata";

const lambdaArnKey = (name: string, region?: string) => {
  return region
    ? `arn:aws:lambda:${region}:\${AWS::AccountId}:function:${name}`
    : `arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${name}`;
};

const referencesEnv = (value: string) => {
  return value.match(/(\${env})/) !== null;
};

const removeEnvReference = (value: string) => {
  return value.replace(/(-\${env})/, "");
};

const lambdaArnResource = (name: string, region?: string) => {
  const substitutions: any = {};
  if (referencesEnv(name)) {
    substitutions["env"] = Fn.Ref(ResourceConstants.PARAMETERS.Env);
  }
  return Fn.If(
    ResourceConstants.CONDITIONS.HasEnvironmentParameter,
    Fn.Sub(lambdaArnKey(name, region), substitutions),
    Fn.Sub(lambdaArnKey(removeEnvReference(name), region), {})
  );
};

export class FirehoseTransformer extends Transformer {
  constructor() {
    super(
      "FirehoseTransformer",
      gql`
        directive @firehose(name: String!, region: String) on OBJECT
      `
    );
  }

  public object = (
    definition: ObjectTypeDefinitionNode,
    directive: DirectiveNode,
    ctx: TransformerContext
  ) => {
    this.validateObject(definition);

    const firehoseLambdaFunctionId = this.createLambdaFunctionResources(
      directive,
      ctx
    );

    this.createFirehoseResolver(
      ctx,
      firehoseLambdaFunctionId,
      ResolverResourceIDs.DynamoDBCreateResolverResourceID(
        definition.name.value
      ),
      "Mutation",
      `create${definition.name.value}`
    );
    this.createFirehoseResolver(
      ctx,
      firehoseLambdaFunctionId,
      ResolverResourceIDs.DynamoDBUpdateResolverResourceID(
        definition.name.value
      ),
      "Mutation",
      `update${definition.name.value}`
    );
    this.createFirehoseResolver(
      ctx,
      firehoseLambdaFunctionId,
      ResolverResourceIDs.DynamoDBDeleteResolverResourceID(
        definition.name.value
      ),
      "Mutation",
      `delete${definition.name.value}`
    );
    this.createFirehoseResolver(
      ctx,
      firehoseLambdaFunctionId,
      ResolverResourceIDs.DynamoDBGetResolverResourceID(definition.name.value),
      "Query",
      `get${definition.name.value}`
    );
    this.createFirehoseResolver(
      ctx,
      firehoseLambdaFunctionId,
      ResolverResourceIDs.DynamoDBListResolverResourceID(definition.name.value),
      "Query",
      plurality(`list${definition.name.value}`)
    );
  };

  private validateObject = (definition: ObjectTypeDefinitionNode) => {
    const modelDirective = (definition.directives || []).find(
      (directive) => directive.name.value === "model"
    );
    if (!modelDirective) {
      throw new InvalidDirectiveError(
        "Types annotated with @firehose must also be annotated with @model."
      );
    }
  };

  private createLambdaFunctionResources = (
    directive: DirectiveNode,
    ctx: TransformerContext
  ) => {
    const { name, region } = getDirectiveArguments(directive);

    // create new IAM role to execute firehose lambda if not yet existing
    const iamRoleId = FunctionResourceIDs.FunctionIAMRoleID(name, region);
    if (!ctx.getResource(iamRoleId)) {
      ctx.setResource(
        iamRoleId,
        new IAM.Role({
          RoleName: Fn.If(
            ResourceConstants.CONDITIONS.HasEnvironmentParameter,
            Fn.Join("-", [
              FunctionResourceIDs.FunctionIAMRoleName(name, true),
              Fn.GetAtt(
                ResourceConstants.RESOURCES.GraphQLAPILogicalID,
                "ApiId"
              ),
              Fn.Ref(ResourceConstants.PARAMETERS.Env),
            ]),
            Fn.Join("-", [
              FunctionResourceIDs.FunctionIAMRoleName(name, false),
              Fn.GetAtt(
                ResourceConstants.RESOURCES.GraphQLAPILogicalID,
                "ApiId"
              ),
            ])
          ),
          AssumeRolePolicyDocument: {
            Version: "2012-10-17",
            Statement: [
              {
                Effect: "Allow",
                Principal: {
                  Service: "appsync.amazonaws.com",
                },
                Action: "sts:AssumeRole",
              },
            ],
          },
          Policies: [
            {
              PolicyName: "InvokeLambdaFunction",
              PolicyDocument: {
                Version: "2012-10-17",
                Statement: [
                  {
                    Effect: "Allow",
                    Action: ["lambda:InvokeFunction"],
                    Resource: lambdaArnResource(name, region),
                  },
                ],
              },
            },
          ],
        })
      );
      ctx.mapResourceToStack(FIREHOSE_DIRECTIVE_STACK, iamRoleId);
    }

    // create new lambda datasource for firehose lambda if not yet existing
    const firehoseLambdaDataSourceName = FunctionResourceIDs.FunctionDataSourceID(
      name,
      region
    );
    if (!ctx.getResource(firehoseLambdaDataSourceName)) {
      ctx.setResource(
        firehoseLambdaDataSourceName,
        new AppSync.DataSource({
          ApiId: Fn.GetAtt(
            ResourceConstants.RESOURCES.GraphQLAPILogicalID,
            "ApiId"
          ),
          Name: firehoseLambdaDataSourceName,
          Type: "AWS_LAMBDA",
          ServiceRoleArn: Fn.GetAtt(iamRoleId, "Arn"),
          LambdaConfig: {
            LambdaFunctionArn: lambdaArnResource(name, region),
          },
        }).dependsOn(iamRoleId)
      );
      ctx.mapResourceToStack(
        FIREHOSE_DIRECTIVE_STACK,
        firehoseLambdaDataSourceName
      );
    }

    // create a pipeline function for the firehose lambda if not yet existing
    const firehoseLambdaFunctionId = FunctionResourceIDs.FunctionAppSyncFunctionConfigurationID(
      name,
      region
    );
    if (!ctx.getResource(firehoseLambdaFunctionId)) {
      ctx.setResource(
        firehoseLambdaFunctionId,
        new AppSync.FunctionConfiguration({
          ApiId: Fn.GetAtt(
            ResourceConstants.RESOURCES.GraphQLAPILogicalID,
            "ApiId"
          ),
          Name: firehoseLambdaFunctionId,
          DataSourceName: firehoseLambdaDataSourceName,
          FunctionVersion: "2018-05-29",
          RequestMappingTemplate: printBlock(
            `Invoke AWS Lambda data source: ${firehoseLambdaDataSourceName}`
          )(
            obj({
              version: str("2018-05-29"),
              operation: str("Invoke"),
              payload: obj({
                typeName: str('$ctx.stash.get("typeName")'),
                fieldName: str('$ctx.stash.get("fieldName")'),
                arguments: ref("util.toJson($ctx.arguments)"),
                identity: ref("util.toJson($ctx.identity)"),
                source: ref("util.toJson($ctx.source)"),
                request: ref("util.toJson($ctx.request)"),
                prev: ref("util.toJson($ctx.prev)"),
              }),
            })
          ),
          ResponseMappingTemplate: printBlock("Handle error or return result")(
            compoundExpression([
              iff(
                ref("ctx.error"),
                raw("$util.error($ctx.error.message, $ctx.error.type)")
              ),
              raw("$util.toJson($ctx.result)"),
            ])
          ),
        }).dependsOn(firehoseLambdaDataSourceName)
      );
      ctx.mapResourceToStack(
        FIREHOSE_DIRECTIVE_STACK,
        firehoseLambdaFunctionId
      );
    }

    return firehoseLambdaFunctionId;
  };

  private createFirehoseResolver = (
    ctx: TransformerContext,
    firehoseLambdaFunctionId: string,
    originalResolverId: string,
    typeName: string,
    fieldName: string
  ) => {
    const fieldNameFirstletterUppercase =
      fieldName[0].toUpperCase() + fieldName.substring(1);

    // get already existing resolver
    const originalResolver = ctx.getResource(originalResolverId);
    if (!originalResolver.Properties) {
      throw new Error(
        "Could not find any properties in the generated resource."
      );
    }

    // build a pipeline function and copy the original data source and mapping templates
    const pipelineFunctionId = `${typeName}${fieldNameFirstletterUppercase}Function`;
    ctx.setResource(
      pipelineFunctionId,
      new AppSync.FunctionConfiguration({
        ApiId: Fn.GetAtt(
          ResourceConstants.RESOURCES.GraphQLAPILogicalID,
          "ApiId"
        ),
        DataSourceName: originalResolver.Properties.DataSourceName,
        FunctionVersion: "2018-05-29",
        Name: pipelineFunctionId,
        RequestMappingTemplate:
          originalResolver.Properties.RequestMappingTemplate,
        ResponseMappingTemplate:
          originalResolver.Properties.ResponseMappingTemplate,
      })
    );
    ctx.mapResourceToStack(FIREHOSE_DIRECTIVE_STACK, pipelineFunctionId);

    // the @model directive does not finalize the resolver mappings directly but only in the
    // after() phase, which is executed after the firehose directive. Therefore we have to
    // finalize the resolvers ourselves to get the auto-generated ID as well as the create and
    // update dates in our DynamoDB pipeline function.
    const ddbMetata = ctx.metadata.get(DYNAMODB_METADATA_KEY);
    const hoistedContentGenerator =
      ddbMetata?.hoistedRequestMappingContent[originalResolverId];
    if (hoistedContentGenerator) {
      const hoistedContent = hoistedContentGenerator();
      if (hoistedContent) {
        const resource: AppSync.Resolver = ctx.getResource(
          pipelineFunctionId
        ) as any;
        resource.Properties.RequestMappingTemplate = [
          hoistedContent,
          resource.Properties.RequestMappingTemplate,
        ].join("\n");
        ctx.setResource(pipelineFunctionId, resource);
      }
    }

    // completely wipe out the original resolver to avoid circular dependencies between stacks
    if (ctx.template.Resources) {
      delete ctx.template.Resources[originalResolverId];
      ctx.getStackMapping().delete(originalResolverId);
      const ddbMetata = ctx.metadata.get(DYNAMODB_METADATA_KEY);
      if (ddbMetata?.hoistedRequestMappingContent) {
        delete ddbMetata.hoistedRequestMappingContent[originalResolverId];
      }
    }

    // create a new pipeline resolver and attach the pipeline functions
    const pipelineResolverId = `${typeName}${fieldNameFirstletterUppercase}PipelineResolver`;
    ctx.setResource(
      pipelineResolverId,
      new AppSync.Resolver({
        ApiId: Fn.GetAtt(
          ResourceConstants.RESOURCES.GraphQLAPILogicalID,
          "ApiId"
        ),
        TypeName: typeName,
        FieldName: fieldName,
        Kind: "PIPELINE",
        PipelineConfig: {
          Functions: [
            Fn.GetAtt(firehoseLambdaFunctionId, "FunctionId"),
            Fn.GetAtt(pipelineFunctionId, "FunctionId"),
          ],
        },
        RequestMappingTemplate: printBlock("Stash resolver specific context.")(
          compoundExpression([
            qref(`$ctx.stash.put("typeName", "${typeName}")`),
            qref(`$ctx.stash.put("fieldName", "${fieldName}")`),
            obj({}),
          ])
        ),
        ResponseMappingTemplate: "$util.toJson($ctx.result)",
      }).dependsOn([firehoseLambdaFunctionId, pipelineFunctionId])
    );
    ctx.mapResourceToStack(FIREHOSE_DIRECTIVE_STACK, pipelineResolverId);
  };
}
